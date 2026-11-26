'use strict';
// Pure Node networking. No shell commands: SSL expiry is read straight from the
// TLS handshake using Node's built-in `tls` module.
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');

const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const MAX_BODY = 5 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SiteWatch/1.0';

function isHomepage(u) {
  return (u.pathname === '/' || u.pathname === '') && !u.search;
}

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('URL is empty');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs are supported');
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('That does not look like a domain');
  return u.toString();
}

/** One HTTP request hop. Resolves {status, headers, body?} or rejects. */
function requestOnce(urlStr, { deadline, wantBody, allowInsecure }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(Object.assign(new Error('Timed out after 15s'), { code: 'TIMEOUT' }));
    const req = lib.request(u, {
      method: 'GET',
      agent: false,
      rejectUnauthorized: !allowInsecure,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      },
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('Timed out after 15s'), { code: 'TIMEOUT' }));
    }, remaining);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('response', (res) => {
      const status = res.statusCode;
      const isRedirect = status >= 300 && status < 400 && res.headers.location;
      if (!wantBody || isRedirect) {
        res.resume();
        res.on('end', () => { clearTimeout(timer); resolve({ status, headers: res.headers }); });
        res.on('error', (e) => { clearTimeout(timer); reject(e); });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (size < MAX_BODY) { chunks.push(c); size += c.length; }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.end();
  });
}

/** Read the certificate presented by host:port, even if it's invalid, so we can report expiry. */
function getCertificate(host, port = 443, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    const sock = tls.connect({
      host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false,
    });
    sock.setTimeout(timeoutMs, () => finish({ error: 'SSL handshake timed out' }));
    sock.once('error', (e) => finish({ error: e.message }));
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      if (!cert || !cert.valid_to) return finish({ error: 'No certificate presented' });
      const validTo = new Date(cert.valid_to);
      finish({
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86400000),
        authorized: sock.authorized,
        authError: sock.authorized ? null : String(sock.authorizationError || ''),
        issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || null,
      });
    });
  });
}

function describeError(e) {
  const code = e && e.code;
  const map = {
    TIMEOUT: 'No response within 15s',
    ENOTFOUND: 'Domain not found (DNS)',
    EAI_AGAIN: 'DNS lookup failed',
    ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'Connection reset',
    EHOSTUNREACH: 'Host unreachable',
    ENETUNREACH: 'Network unreachable',
    CERT_HAS_EXPIRED: 'SSL certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed SSL certificate',
    SELF_SIGNED_CERT_IN_CHAIN: 'Untrusted SSL certificate chain',
    ERR_TLS_CERT_ALTNAME_INVALID: 'SSL certificate does not match domain',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Incomplete SSL certificate chain',
  };
  return map[code] || (e && e.message) || 'Unknown error';
}

/**
 * Check one site.
 * Returns { ts, up, status, ms, error, ssl, keywordOk, final }
 * Rules: DOWN if no response in 15s, 5xx, 4xx on a homepage URL, or required keyword missing.
 */
async function checkSite(site, opts = {}) {
  const ts = Date.now();
  const start = Date.now();
  const deadline = start + (opts.timeoutMs || TIMEOUT_MS);
  const origin = new URL(site.url);
  const home = isHomepage(origin);
  const keyword = (site.keyword || '').trim();

  const sslPromise = origin.protocol === 'https:'
    ? getCertificate(origin.hostname, Number(origin.port) || 443)
    : Promise.resolve(null);

  let status = null, error = null, body = null, finalUrl = site.url, warn = null;
  try {
    let current = site.url;
    for (let hop = 0; ; hop++) {
      const res = await requestOnce(current, { deadline, wantBody: true, allowInsecure: false });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= MAX_REDIRECTS) { error = 'Too many redirects'; status = res.status; break; }
        current = new URL(res.headers.location, current).toString();
        continue;
      }
      status = res.status;
      body = res.body;
      finalUrl = current;
      break;
    }
  } catch (e) {
    error = describeError(e);
  }
  const ms = Date.now() - start;

  let up = true;
  let keywordOk = null;
  if (error) up = false;
  else if (status >= 500) { up = false; error = `Server error (HTTP ${status})`; }
  else if (status >= 400) {
    if (home) { up = false; error = `HTTP ${status} on homepage`; }
    else warn = `HTTP ${status}`;
  }
  if (up && keyword) {
    keywordOk = (body || '').toLowerCase().includes(keyword.toLowerCase());
    if (!keywordOk) { up = false; error = `Keyword "${keyword}" not found on page`; }
  }

  const ssl = await sslPromise;
  return {
    ts, up, status, ms: error && /15s/.test(error) ? null : ms, error, warn, keywordOk,
    final: finalUrl !== site.url ? finalUrl : undefined,
    ssl: ssl ? (ssl.error ? { error: ssl.error } : { daysLeft: ssl.daysLeft, validTo: ssl.validTo, valid: ssl.authorized, authError: ssl.authError, issuer: ssl.issuer }) : null,
  };
}

/** Is *this computer* online? Used so a dead Wi-Fi doesn't fire "all sites down". */
function isOnline() {
  const probe = (host, port) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    const end = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(5000, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
  return Promise.all([probe('1.1.1.1', 443), probe('8.8.8.8', 443), probe('9.9.9.9', 443)])
    .then((r) => r.some(Boolean));
}

module.exports = { checkSite, getCertificate, isOnline, normalizeUrl, isHomepage };
