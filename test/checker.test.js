'use strict';
// Integration tests against local HTTP/HTTPS servers (no internet needed).
const assert = require('assert');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkSite, normalizeUrl } = require('../src/checker');
const { Monitor } = require('../src/monitor');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
// Test-only: generate a self-signed cert expiring in 5 days.
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '5', '-subj', '/CN=localhost'], { stdio: 'ignore' });

const handler = (req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>Welcome to the shop</h1>'); }
  if (req.url === '/redir') { res.writeHead(301, { location: '/' }); return res.end(); }
  if (req.url === '/500') { res.writeHead(500); return res.end('boom'); }
  if (req.url === '/missing') { res.writeHead(404); return res.end('nope'); }
  if (req.url === '/slow') return; // never answers
  res.writeHead(404); res.end();
};

(async () => {
  const srv = http.createServer(handler).listen(0);
  const tlsSrv = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, handler).listen(0);
  const H = `http://localhost:${srv.address().port}`;
  const S = `https://localhost:${tlsSrv.address().port}`;
  const site = (url, keyword) => ({ url, keyword });
  let r;

  r = await checkSite(site(H + '/')); assert.strictEqual(r.up, true); assert.strictEqual(r.status, 200); assert.ok(r.ms >= 0); assert.strictEqual(r.ssl, null);
  r = await checkSite(site(H + '/', 'welcome')); assert.strictEqual(r.up, true); assert.strictEqual(r.keywordOk, true);
  r = await checkSite(site(H + '/', 'Out of stock')); assert.strictEqual(r.up, false); assert.match(r.error, /Keyword/);
  r = await checkSite(site(H + '/redir')); assert.strictEqual(r.up, true); assert.strictEqual(r.status, 200);
  r = await checkSite(site(H + '/500')); assert.strictEqual(r.up, false); assert.match(r.error, /500/);
  r = await checkSite(site(H + '/missing')); assert.strictEqual(r.up, true, '404 on a deep link is a warning, not down'); assert.match(r.warn, /404/);
  // 404 on homepage → down
  const srv404 = http.createServer((q, s) => { s.writeHead(404); s.end(); }).listen(0);
  r = await checkSite(site(`http://localhost:${srv404.address().port}/`)); assert.strictEqual(r.up, false); assert.match(r.error, /homepage/);
  r = await checkSite(site(H + '/slow'), { timeoutMs: 800 }); assert.strictEqual(r.up, false); assert.match(r.error, /15s|response/);
  r = await checkSite(site('http://localhost:1/')); assert.strictEqual(r.up, false); assert.match(r.error, /refused/i);
  // Self-signed cert: site is down (untrusted) but we still read the expiry.
  r = await checkSite(site(S + '/')); assert.strictEqual(r.up, false); assert.match(r.error, /Self-signed/); assert.ok(r.ssl.daysLeft === 4 || r.ssl.daysLeft === 5, 'daysLeft=' + r.ssl.daysLeft); assert.strictEqual(r.ssl.valid, false);
  assert.strictEqual(normalizeUrl('example.com'), 'https://example.com/');
  assert.throws(() => normalizeUrl('ftp://x.com'));
  console.log('checker: ok');

  // ---------- monitor: alert de-dup, retry, offline suppression, SSL thresholds ----------
  let now = 1_000_000_000_000;
  const mem = {}; const store = { load: (k, d) => mem[k] ?? d, save: (k, v) => { mem[k] = v; } };
  const alerts = [];
  let next = { up: true, status: 200, ms: 100, ssl: { daysLeft: 30, validTo: new Date().toISOString() } };
  let online = true, calls = 0;
  const m = new Monitor({ store, notify: (a) => alerts.push(a.kind + ':' + a.title), checkFn: async () => { calls++; return { ts: now, ...JSON.parse(JSON.stringify(next)) }; }, onlineFn: async () => online, now: () => now, retryDelayMs: 1 });
  const s = m.addSite({ url: 'example.com', nickname: 'Shop' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(m.level(s.id), 'green');

  next = { up: false, status: 503, ms: 50, error: 'Server error (HTTP 503)', ssl: null };
  calls = 0; await m.checkOne(s.id); assert.strictEqual(calls, 2, 'retries once before declaring down');
  assert.deepStrictEqual(alerts, ['down:🔴 Shop is DOWN']);
  now += 20 * 60000; await m.checkOne(s.id); assert.strictEqual(alerts.length, 1, 'no repeat within the hour');
  now += 41 * 60000; await m.checkOne(s.id); assert.strictEqual(alerts.length, 2); assert.match(alerts[1], /still DOWN/);
  next = { up: true, status: 200, ms: 90, ssl: { daysLeft: 30, validTo: new Date().toISOString() } };
  now += 60000; await m.checkOne(s.id); assert.match(alerts[2], /back UP/);
  const inc = m.detail(s.id).incidents; assert.strictEqual(inc.length, 1); assert.ok(inc[0].end);

  // Blip that recovers on retry: no alert
  let flip = 0; m.checkFn = async () => (flip++ === 0 ? { ts: now, up: false, error: 'x' } : { ts: now, up: true, status: 200, ms: 1 });
  await m.checkOne(s.id); assert.strictEqual(alerts.length, 3, 'blip suppressed');

  // Offline: no alert, level unknown
  m.checkFn = async () => ({ ts: now, up: false, error: 'Domain not found (DNS)' });
  online = false; now += 5 * 60000; m.onlineCache = null; await m.checkOne(s.id);
  assert.strictEqual(alerts.length, 3, 'offline suppressed'); assert.strictEqual(m.level(s.id), 'unknown');
  online = true;

  // SSL: warn at 14, crit at 3, daily reminder not hourly
  m.checkFn = async () => ({ ts: now, ...JSON.parse(JSON.stringify(next)) });
  next = { up: true, status: 200, ms: 1, ssl: { daysLeft: 14, validTo: new Date().toISOString() } };
  now += 60000; await m.checkOne(s.id); assert.match(alerts[3], /SSL certificate expires in 14 days/); assert.strictEqual(m.level(s.id), 'amber');
  now += 2 * 3600000; await m.checkOne(s.id); assert.strictEqual(alerts.length, 4);
  next.ssl.daysLeft = 3; now += 60000; await m.checkOne(s.id); assert.match(alerts[4], /expires in 3 days/); assert.strictEqual(m.level(s.id), 'red');
  now += 25 * 3600000; await m.checkOne(s.id); assert.strictEqual(alerts.length, 6, 'daily reminder');

  console.log('monitor: ok');
  console.log(alerts.join('\n'));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
