// Half-hourly price forecasts from AEMO's pre-dispatch runs.
//
// The main source is forecast.json, published next to the app every
// 30 minutes by a GitHub Actions job (scripts/fetch-forecast.mjs) that
// reads the official files on NEMWeb. The API behind AEMO's NEM data
// dashboard is the fallback: it allows browser requests but is
// undocumented and has had outages.
const FORECAST_FILE = './forecast.json'
const API_ENDPOINT = 'https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN'
const API_TIMEOUT_MS = 15000
// Pre-dispatch runs every 30 minutes; scheduled jobs can run late.
const MAX_FILE_AGE_MS = 75 * 60 * 1000

const HALF_HOUR = 30 * 60 * 1000

// NEM market time is AEST all year round (no daylight saving).
const NEM_OFFSET = '+10:00'

export function parseNemTime(s) {
  return new Date(`${s}${NEM_OFFSET}`)
}

const slotEnding = (end, price) => ({ start: new Date(end.getTime() - HALF_HOUR), end, price }) // price in $/MWh

// Turns forecast.json into 30-minute slots for one region.
export function fileToSlots(data, region = 'VIC1') {
  return (data.regions?.[region] ?? [])
    .map((r) => slotEnding(new Date(r.end), r.rrp))
    .sort((a, b) => a.start - b.start)
}

// Turns dashboard API rows into 30-minute slots for one region.
// SETTLEMENTDATE marks the end of each interval.
export function toSlots(rows, region = 'VIC1') {
  return rows
    .filter((r) => r.REGIONID === region && r.PERIODTYPE === 'FORECAST')
    .map((r) => slotEnding(parseNemTime(r.SETTLEMENTDATE), r.RRP))
    .sort((a, b) => a.start - b.start)
}

async function fetchFile(region) {
  const res = await fetch(FORECAST_FILE, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`forecast file returned ${res.status}`)
  const data = await res.json()
  const slots = fileToSlots(data, region)
  if (!slots.length) throw new Error('forecast file has no prices')
  return { slots, publishedAt: new Date(data.publishedAt), source: 'file' }
}

async function fetchApi(region) {
  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Forecast rows only come back when both timescales are requested.
    body: JSON.stringify({ timeScale: ['5MIN', '30MIN'] }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`AEMO dashboard API returned ${res.status}`)
  const data = await res.json()
  const slots = toSlots(data['5MIN'] ?? [], region)
  if (!slots.length) throw new Error('AEMO dashboard API returned no forecast')
  return { slots, publishedAt: null, source: 'api' }
}

// Returns { slots, publishedAt, source, stale }. Uses the published file
// while it's recent, then the dashboard API, then an old file over nothing.
export async function fetchForecast(region = 'VIC1', now = new Date()) {
  const errors = []
  let file = null
  try {
    file = await fetchFile(region)
    if (now - file.publishedAt <= MAX_FILE_AGE_MS) return { ...file, stale: false }
  } catch (e) {
    errors.push(e.message)
  }
  try {
    return { ...(await fetchApi(region)), stale: false }
  } catch (e) {
    errors.push(e.name === 'TimeoutError' ? 'AEMO dashboard API timed out' : e.message)
  }
  if (file) return { ...file, stale: true }
  throw new Error(errors.join('; '))
}
