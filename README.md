# Travel Expense Tracker PWA

Private, offline-first travel expense tracker for a single user.

## Features
- Trip CRUD with budget settings
- Expense CRUD with per-expense manual FX and base conversion
- Filters (date, category, payment, text search)
- Dashboard: total, category split, daily totals, payment split, budget remaining
- CSV export per active trip
- Full JSON backup and full-overwrite JSON restore
- IndexedDB local storage only (no server calls)
- Installable PWA with service worker app-shell caching

## Tech
- Vanilla HTML/CSS/JS
- Native IndexedDB wrapper (`db.js`)
- Service worker (`sw.js`)

## Local development
1. Serve the folder over HTTP from project root:
```bash
python3 -m http.server 5173
```
2. Open `http://localhost:5173`.
3. For offline testing, open DevTools and toggle offline after first load.

## Production deployment (HTTPS)
1. Deploy all files in this repository as static assets.
2. Ensure HTTPS is enabled (required for service worker in production).
3. Verify `manifest.json` and `sw.js` are reachable with HTTP 200.
4. Load once online, then confirm offline behavior.

## Data storage and privacy
- User data is stored only in browser IndexedDB.
- No analytics and no API calls for expense/trip data.
- Export is explicit user action (CSV/JSON download).

## Manual QA checklist
- [ ] Create trip validates required fields and date range.
- [ ] Active trip selector switches context across screens.
- [ ] Add/edit/delete expense works and persists after reload.
- [ ] Non-base currency requires FX and computes base amount correctly.
- [ ] Base-currency expense forces FX=1 and hides FX input.
- [ ] Expense list sorting/filtering works.
- [ ] Dashboard totals match filtered expense sums.
- [ ] CSV exports with exact required column order.
- [ ] JSON backup exports all trips/expenses/config.
- [ ] JSON restore shows summary and overwrites local data after confirmation.
- [ ] App works offline after first load.
- [ ] PWA install prompt works where supported.

## Sample data
- Restore from: `data/sample_backup.json`

## Notes
- v1 behavior blocks base currency changes when expenses already exist for a trip.
- Burn rate uses **days elapsed** from trip start to today (capped by trip end).
