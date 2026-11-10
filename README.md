# NEM Charge Planner

A browser-only Vue app that reads AEMO's wholesale price forecast for
Victoria (VIC1) and works out the cheapest times to use a given amount of
energy before a deadline, skipping times you've blocked out (e.g. when the
car isn't plugged in).

- [Visit the NEM Charge Planner](https://maikels-agent.github.io/nem-charge-planner/)

## Run

```bash
npm install
npm run dev     # development server
npm test        # scheduler tests
npm run build   # static site in dist/, host anywhere
```

## How it works

- **Forecast data.** `scripts/fetch-forecast.mjs` downloads AEMO's latest
  pre-dispatch run from NEMWeb (`PredispatchIS_Reports`) and writes
  each region's half-hourly price forecast (`REGION_PRICES`) to
  `forecast.json`. NEMWeb doesn't allow browser requests, so the Pages
  workflow runs this every 30 minutes and publishes the file next to the
  app. The forecast runs to the end of the next trading day (4am), so it
  covers between about 22 and 46 hours. Times are in NEM time (AEST,
  UTC+10) and mark the end of each period.
- `src/lib/aemo.js` loads `forecast.json`. If that is missing or more
  than 75 minutes old it tries the undocumented API behind AEMO's NEM
  dashboard (`visualisations.aemo.com.au`), and if that fails too it
  uses the old file and says it's out of date. For local development,
  run `npm run forecast` to write `public/forecast.json`.
- `src/lib/scheduler.js` works out how many minutes of each slot are
  usable (after now, before the deadline, outside blocked times), then
  fills the cheapest slots first at the charger's power.
  Each charging session runs for at least the minimum charge time
  (default 60 minutes): sessions that would be shorter are extended or
  dropped, whichever is cheaper.
  - **Fixed amount:** the energy needed plus the energy used in blocks has
    to be charged by the deadline. Cheapest-first is optimal here.
  - **From battery level** (default, 20% → 80% of 50 kWh): the battery
    level is tracked over time. Each block that uses energy (a trip) must
    have that energy in the battery when it starts, the battery never
    goes over capacity, and it must reach the target by the deadline.
    Each requirement is met in time order from the cheapest slots before
    it. A trip already under way is left out, because "charge now"
    already shows the current level.
- Settings are saved in `localStorage`. The forecast refreshes every
  5 minutes.

## Caveats

- GitHub disables scheduled workflows in public repositories after
  60 days without activity in the repository. If the forecast stops
  updating, re-enable the workflow under Actions.
- Scheduled runs can start late when GitHub is busy, so the forecast can
  be up to an hour old.
- Prices are wholesale. Use the "Network + retail extra" field to add
  roughly what your retailer charges on top.

## Deploy

Pushes to `main` are built, tested and published to GitHub Pages by
`.github/workflows/deploy.yml`. In the repository settings, under
Pages, set **Source** to **GitHub Actions**.
