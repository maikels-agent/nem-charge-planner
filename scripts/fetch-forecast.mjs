// Downloads AEMO's latest pre-dispatch run from NEMWeb and writes the
// half-hourly price forecast for each region as JSON. NEMWeb doesn't allow
// browser requests, so GitHub Actions runs this and publishes the result
// next to the app.
//
//   node scripts/fetch-forecast.mjs <output.json>
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const DIR = 'https://nemweb.com.au/Reports/Current/PredispatchIS_Reports/'
const FILE_PATTERN = /PUBLIC_PREDISPATCHIS_(\d{12})_(\d{14})\.zip/g

// NEM market time is AEST all year round.
const nemTime = (s) => `${s.replaceAll('/', '-').replace(' ', 'T')}+10:00`
const compactTime = (s) =>
  nemTime(`${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14) || '00'}`)

export function latestFile(listingHtml) {
  const names = [...new Set([...listingHtml.matchAll(FILE_PATTERN)].map((m) => m[0]))]
  return names.sort().at(-1) ?? null
}

// Reads the first file from a zip archive using its central directory.
export function unzipFirst(buffer) {
  const buf = Buffer.from(buffer)
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('Not a zip file')
  const entry = buf.readUInt32LE(eocd + 16)
  if (buf.readUInt32LE(entry) !== 0x02014b50) throw new Error('Bad zip directory')
  const method = buf.readUInt16LE(entry + 10)
  const size = buf.readUInt32LE(entry + 20)
  const local = buf.readUInt32LE(entry + 42)
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
  const data = buf.subarray(start, start + size)
  if (method === 0) return data.toString('latin1')
  if (method === 8) return inflateRawSync(data).toString('latin1')
  throw new Error(`Unsupported zip compression method ${method}`)
}

function splitCsvLine(line) {
  const fields = []
  let field = ''
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) {
      fields.push(field)
      field = ''
    } else field += ch
  }
  fields.push(field)
  return fields
}

// Pulls PREDISPATCH REGION_PRICES out of an AEMO CSV report. DATETIME is
// the end of each 30-minute period. Rows from intervention runs are
// skipped, because prices are set by the run without intervention.
export function parseRegionPrices(csv) {
  const regions = {}
  let columns = null
  for (const line of csv.split(/\r?\n/)) {
    if (!line.startsWith('I,PREDISPATCH,REGION_PRICES,') && !line.startsWith('D,PREDISPATCH,REGION_PRICES,')) continue
    const fields = splitCsvLine(line)
    if (fields[0] === 'I') {
      columns = Object.fromEntries(fields.map((name, i) => [name, i]))
      continue
    }
    if (!columns) throw new Error('REGION_PRICES data before its header')
    if ((fields[columns.INTERVENTION] ?? '0') !== '0') continue
    const region = fields[columns.REGIONID]
    ;(regions[region] ??= []).push({ end: nemTime(fields[columns.DATETIME]), rrp: Number(fields[columns.RRP]) })
  }
  for (const rows of Object.values(regions)) rows.sort((a, b) => a.end.localeCompare(b.end))
  if (!Object.keys(regions).length) throw new Error('No REGION_PRICES rows found')
  return regions
}

export async function fetchForecast() {
  const listing = await fetch(DIR)
  if (!listing.ok) throw new Error(`NEMWeb listing returned ${listing.status}`)
  const name = latestFile(await listing.text())
  if (!name) throw new Error('No pre-dispatch files listed')
  const zip = await fetch(DIR + name)
  if (!zip.ok) throw new Error(`NEMWeb returned ${zip.status} for ${name}`)
  const [, run, published] = name.match(/(\d{12})_(\d{14})/)
  return {
    source: 'AEMO pre-dispatch (NEMWeb)',
    file: name,
    run: compactTime(run),
    publishedAt: compactTime(published),
    fetchedAt: new Date().toISOString(),
    regions: parseRegionPrices(unzipFirst(await zip.arrayBuffer())),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2]
  if (!out) {
    console.error('Usage: node scripts/fetch-forecast.mjs <output.json>')
    process.exit(1)
  }
  const forecast = await fetchForecast()
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(forecast))
  const counts = Object.entries(forecast.regions).map(([r, rows]) => `${r}: ${rows.length}`).join(', ')
  console.log(`${forecast.file} → ${out} (${counts})`)
}
