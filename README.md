# SiteWatch

A compact Windows tray app that monitors websites: uptime, response time, SSL expiry and a required keyword.

## Run
- **Portable:** unzip `SiteWatch-1.0.0-win.zip` anywhere and run `SiteWatch.exe`.
- **From source:** `npm install`, then `npm start`.
- **Build an installer (on Windows):** `npm run dist`. This gives you `dist/SiteWatch Setup 1.0.0.exe` plus a zip.

## Rules
| Condition | Result |
|---|---|
| No response within 15s, connection or DNS error, invalid SSL | 🔴 Down |
| HTTP 5xx | 🔴 Down |
| HTTP 4xx on a homepage URL (path `/`) | 🔴 Down |
| HTTP 4xx on a deeper URL | 🟠 Warning |
| Required keyword missing (case-insensitive) | 🔴 Down |
| SSL expires in ≤ 3 days / ≤ 14 days | 🔴 / 🟠 |

A failed check is retried once after 5s before the site is marked down. If a check fails while this PC itself is offline, it is greyed out and no alert is sent.

## Alerts
- **Down:** sent right away, then repeated at most once an hour while the site stays down.
- **Back up:** sent once, with how long the site was down.
- **SSL:** sent when a certificate crosses the warning or critical threshold, then a reminder at most once every 24h.

## Data
Everything is stored in `%APPDATA%\SiteWatch\*.json`: sites, settings, 48h of check history and 30 days of incidents.

## Tests
`npm test` runs against local HTTP/HTTPS servers.

## Keyboard
| Keys | Action |
|---|---|
| Ctrl+Alt+M (changeable) | Show or hide SiteWatch from any app |
| F5 | Check all sites, or the open site |
| Ctrl+N | Add a site |
| Ctrl+, | Open settings |
| Delete | Delete the selected site (asks first) |
| Esc | Go back / close a panel |
| / | Search (shown once you have more than 10 sites) |

## Licence
MIT. See `LICENSE`.
