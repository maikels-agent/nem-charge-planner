# NEM Charge Planner

A browser-only Vue app that reads AEMO's wholesale price forecast for
Victoria (VIC1) and works out the cheapest times to use a given amount of
energy before a deadline, skipping times you've blocked out (e.g. when the
car isn't plugged in).

## Run

```bash
npm install
npm run dev     # development server
npm test        # scheduler tests
npm run build   # static site in dist/, host anywhere
```

## How it works

- `src/lib/aemo.js` fetches forecasts from the API behind AEMO's NEM
  dashboard (`visualisations.aemo.com.au/.../report/5MIN`). It allows
  cross-origin requests, so no backend is needed. It only returns
  forecast rows when the request asks for both `5MIN` and `30MIN`
  timescales. The forecast covers roughly the next 36 hours in 30-minute
  periods. Timestamps are in NEM time (AEST, UTC+10) and mark the end of
  each period.
- `src/lib/scheduler.js` works out how many minutes of each slot are
  usable (after now, before the deadline, outside blocked times), then
  fills the cheapest slots first at the charger's power. With a constant
  charging rate this greedy approach is optimal.
- Settings are saved in `localStorage`. The forecast refreshes every
  5 minutes.

## Caveats

- The AEMO endpoint is undocumented and could change. If it does, swap
  `fetchForecast` for a small proxy (e.g. a Cloudflare Worker) that
  reads the pre-dispatch files from NEMWeb.
- Prices are wholesale. Use the "Network + retail extra" field to add
  roughly what your retailer charges on top.

## Deploy

Pushes to `main` are built, tested and published to GitHub Pages by
`.github/workflows/deploy.yml`. In the repository settings, under
Pages, set **Source** to **GitHub Actions**.
