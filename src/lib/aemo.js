// Price forecasts from the API behind AEMO's NEM data dashboard.
// It is undocumented but sends `Access-Control-Allow-Origin: *`, so the
// browser can call it directly. Forecast rows only come back when both
// timescales are requested.
const ENDPOINT = 'https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN'

// NEM market time is AEST all year round (no daylight saving).
const NEM_OFFSET = '+10:00'

export function parseNemTime(s) {
  return new Date(`${s}${NEM_OFFSET}`)
}

// Turns raw API rows into 30-minute slots for one region.
// SETTLEMENTDATE marks the end of each interval.
export function toSlots(rows, region = 'VIC1') {
  return rows
    .filter((r) => r.REGIONID === region && r.PERIODTYPE === 'FORECAST')
    .map((r) => {
      const end = parseNemTime(r.SETTLEMENTDATE)
      return {
        start: new Date(end.getTime() - 30 * 60 * 1000),
        end,
        price: r.RRP, // $/MWh
      }
    })
    .sort((a, b) => a.start - b.start)
}

export async function fetchForecast(region = 'VIC1') {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeScale: ['5MIN', '30MIN'] }),
  })
  if (!res.ok) throw new Error(`AEMO returned ${res.status}`)
  const data = await res.json()
  return toSlots(data['5MIN'] ?? [], region)
}
