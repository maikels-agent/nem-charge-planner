import { afterEach, describe, expect, it, vi } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { latestFile, parseRegionPrices, unzipFirst } from '../scripts/fetch-forecast.mjs'
import { fetchForecast, fileToSlots } from '../src/lib/aemo.js'

const CSV = [
  'C,NEMP.WORLD,PREDISPATCHIS,AEMO,PUBLIC,2026/11/07,05:32:02,0000000123,PREDISPATCHIS,0000000123',
  'I,PREDISPATCH,REGION_PRICES,1,PREDISPATCHSEQNO,RUNNO,REGIONID,PERIODID,INTERVENTION,RRP,DATETIME',
  'D,PREDISPATCH,REGION_PRICES,1,2026110701,1,VIC1,02,0,0.01,"2026/11/07 06:30:00"',
  'D,PREDISPATCH,REGION_PRICES,1,2026110701,1,VIC1,01,0,10.5,"2026/11/07 06:00:00"',
  'D,PREDISPATCH,REGION_PRICES,1,2026110701,1,VIC1,01,1,999,"2026/11/07 06:00:00"',
  'D,PREDISPATCH,REGION_PRICES,1,2026110701,1,NSW1,01,0,-20,"2026/11/07 06:00:00"',
  'I,PREDISPATCH,OTHER,1,FOO',
  'D,PREDISPATCH,OTHER,1,BAR',
  'C,"END OF REPORT",8',
].join('\r\n')

// A minimal single-file zip archive, like the ones on NEMWeb.
function zip(name, text) {
  const data = deflateRawSync(Buffer.from(text, 'latin1'))
  const nameBuf = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt16LE(nameBuf.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(0, 42)
  const cdOffset = local.length + nameBuf.length + data.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + nameBuf.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd])
}

describe('fetch-forecast script', () => {
  it('finds the newest pre-dispatch file in a listing', () => {
    const html = `
      <a href="/x/PUBLIC_PREDISPATCHIS_202611070530_20261107050217.zip">PUBLIC_PREDISPATCHIS_202611070530_20261107050217.zip</a>
      <a href="/x/PUBLIC_PREDISPATCHIS_202611070600_20261107053202.zip">PUBLIC_PREDISPATCHIS_202611070600_20261107053202.zip</a>
      <a href="/x/PUBLIC_PREDISPATCHIS_202611070500_20261107043215.zip">PUBLIC_PREDISPATCHIS_202611070500_20261107043215.zip</a>`
    expect(latestFile(html)).toBe('PUBLIC_PREDISPATCHIS_202611070600_20261107053202.zip')
  })

  it('unzips the report', () => {
    expect(unzipFirst(zip('REPORT.CSV', CSV))).toBe(CSV)
  })

  it('reads region prices, skipping intervention runs', () => {
    const regions = parseRegionPrices(CSV)
    expect(regions.VIC1).toEqual([
      { end: '2026-11-07T06:00:00+10:00', rrp: 10.5 },
      { end: '2026-11-07T06:30:00+10:00', rrp: 0.01 },
    ])
    expect(regions.NSW1).toEqual([{ end: '2026-11-07T06:00:00+10:00', rrp: -20 }])
  })

  it('fails on a report without region prices', () => {
    expect(() => parseRegionPrices('C,NOTHING')).toThrow()
  })
})

describe('fetchForecast', () => {
  afterEach(() => vi.unstubAllGlobals())

  const file = {
    publishedAt: '2026-11-07T05:32:02+10:00',
    regions: { VIC1: [{ end: '2026-11-07T06:00:00+10:00', rrp: 10.5 }] },
  }
  const apiData = {
    '5MIN': [{ SETTLEMENTDATE: '2026-11-07T06:00:00', REGIONID: 'VIC1', PERIODTYPE: 'FORECAST', RRP: 42 }],
  }
  const json = (body) => ({ ok: true, json: async () => body })
  const failed = { ok: false, status: 500 }

  function stubFetch({ fileRes, apiRes }) {
    const fetch = vi.fn(async (url) => (String(url).includes('forecast.json') ? fileRes : apiRes))
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('turns the file into slots', () => {
    const [slot] = fileToSlots(file)
    expect(slot.start.toISOString()).toBe('2026-11-06T19:30:00.000Z')
    expect(slot.price).toBe(10.5)
  })

  it('uses a recent file without calling the API', async () => {
    const fetch = stubFetch({ fileRes: json(file), apiRes: json(apiData) })
    const result = await fetchForecast('VIC1', new Date('2026-11-07T06:00:00+10:00'))
    expect(result.source).toBe('file')
    expect(result.stale).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to the API when the file is old', async () => {
    stubFetch({ fileRes: json(file), apiRes: json(apiData) })
    const result = await fetchForecast('VIC1', new Date('2026-11-07T09:00:00+10:00'))
    expect(result.source).toBe('api')
    expect(result.slots[0].price).toBe(42)
  })

  it('uses an old file when the API is down', async () => {
    stubFetch({ fileRes: json(file), apiRes: failed })
    const result = await fetchForecast('VIC1', new Date('2026-11-07T09:00:00+10:00'))
    expect(result.source).toBe('file')
    expect(result.stale).toBe(true)
  })

  it('reports both errors when nothing works', async () => {
    stubFetch({ fileRes: { ok: false, status: 404 }, apiRes: failed })
    await expect(fetchForecast('VIC1')).rejects.toThrow(/404.*500/)
  })
})
