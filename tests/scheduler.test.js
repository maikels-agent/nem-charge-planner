import { describe, expect, it } from 'vitest'
import { expandBlocks, planCharging, usableMinutes } from '../src/lib/scheduler.js'
import { toSlots } from '../src/lib/aemo.js'

const t = (hhmm, day = 1) => new Date(2026, 10, day, ...hhmm.split(':').map(Number))

function slotsFrom(startHHMM, prices) {
  const start = t(startHHMM)
  return prices.map((price, i) => ({
    start: new Date(start.getTime() + i * 30 * 60000),
    end: new Date(start.getTime() + (i + 1) * 30 * 60000),
    price,
  }))
}

describe('planCharging', () => {
  it('picks the cheapest slots first', () => {
    const slots = slotsFrom('00:00', [100, 20, 50, -10])
    const result = planCharging({
      slots, now: t('00:00'), deadline: t('02:00'), energyKwh: 7, powerKw: 7,
    })
    expect(result.plan.map((s) => s.kwh)).toEqual([0, 3.5, 0, 3.5])
    expect(result.shortfallKwh).toBe(0)
    expect(result.wholesaleCost).toBeCloseTo((20 * 3.5 - 10 * 3.5) / 1000)
  })

  it('splits the last slot when less energy is needed', () => {
    const slots = slotsFrom('00:00', [10, 20])
    const result = planCharging({
      slots, now: t('00:00'), deadline: t('01:00'), energyKwh: 5, powerKw: 7,
    })
    expect(result.plan.map((s) => s.kwh)).toEqual([3.5, 1.5])
  })

  it('reports a shortfall when there is not enough time', () => {
    const slots = slotsFrom('00:00', [10, 20])
    const result = planCharging({
      slots, now: t('00:00'), deadline: t('01:00'), energyKwh: 10, powerKw: 7,
    })
    expect(result.shortfallKwh).toBeCloseTo(3)
  })

  it('ignores time before now and after the deadline', () => {
    const slots = slotsFrom('00:00', [1, 50, 2])
    const result = planCharging({
      slots, now: t('00:15'), deadline: t('01:15'), energyKwh: 100, powerKw: 4,
    })
    expect(result.plan.map((s) => s.kwh)).toEqual([1, 2, 1])
  })

  it('skips blocked periods', () => {
    const slots = slotsFrom('00:00', [1, 2, 3])
    const result = planCharging({
      slots, now: t('00:00'), deadline: t('01:30'), energyKwh: 4, powerKw: 4,
      blocks: [{ type: 'daily', from: '00:00', to: '00:30' }],
    })
    expect(result.plan.map((s) => s.kwh)).toEqual([0, 2, 2])
  })

  it('adds energy used during blocks before the deadline', () => {
    const slots = slotsFrom('00:00', [1, 2, 3, 4])
    const result = planCharging({
      slots, now: t('00:00'), deadline: t('02:00'), energyKwh: 1, powerKw: 4,
      blocks: [
        { type: 'once', start: t('01:00'), end: t('01:30'), kwh: 1.5 },
        // starts after the deadline, so it doesn't count
        { type: 'once', start: t('03:00'), end: t('04:00'), kwh: 10 },
      ],
    })
    expect(result.blockKwh).toBe(1.5)
    expect(result.blockCount).toBe(1)
    expect(result.totalKwh).toBe(2.5)
    expect(result.plan.map((s) => s.kwh)).toEqual([2, 0.5, 0, 0])
  })

  it('counts every occurrence of a weekly block', () => {
    const slots = slotsFrom('00:00', [1])
    const result = planCharging({
      slots, now: t('00:00', 2), deadline: t('00:00', 5), energyKwh: 0, powerKw: 4,
      blocks: [{ type: 'daily', from: '08:00', to: '09:00', kwh: 3 }],
    })
    // 2, 3 and 4 Nov
    expect(result.blockCount).toBe(3)
    expect(result.blockKwh).toBe(9)
  })

  it('merges adjacent slots into windows', () => {
    const slots = slotsFrom('00:00', [1, 1, 9, 1])
    const result = planCharging({
      slots, now: t('00:00'), deadline: t('02:00'), energyKwh: 6, powerKw: 4,
    })
    expect(result.windows).toHaveLength(2)
    expect(result.windows[0].end).toEqual(t('01:00'))
  })
})

describe('expandBlocks', () => {
  it('handles daily blocks that wrap past midnight', () => {
    const ranges = expandBlocks([{ type: 'daily', from: '22:00', to: '06:00' }], t('03:00'), t('04:00'))
    expect(ranges.some(([s, e]) => s <= t('03:00') && e >= t('04:00'))).toBe(true)
  })

  it('respects weekdays', () => {
    // 1 Nov 2026 is a Sunday
    const ranges = expandBlocks([{ type: 'daily', from: '08:00', to: '18:00', days: [1, 2, 3, 4, 5] }], t('00:00'), t('23:00'))
    expect(ranges.filter(([s]) => s.getDate() === 1)).toHaveLength(0)
  })
})

describe('usableMinutes', () => {
  it('does not double count overlapping blocks', () => {
    const slot = { start: t('00:00'), end: t('00:30') }
    const blocks = [[t('00:00'), t('00:20')], [t('00:10'), t('00:25')]]
    expect(usableMinutes(slot, t('00:00'), t('01:00'), blocks)).toBe(5)
  })
})

describe('toSlots', () => {
  it('keeps VIC1 forecasts and treats SETTLEMENTDATE as period end in AEST', () => {
    const rows = [
      { SETTLEMENTDATE: '2026-10-29T16:00:00', REGIONID: 'VIC1', PERIODTYPE: 'FORECAST', RRP: -34.89 },
      { SETTLEMENTDATE: '2026-10-29T16:00:00', REGIONID: 'NSW1', PERIODTYPE: 'FORECAST', RRP: 50 },
      { SETTLEMENTDATE: '2026-10-29T15:55:00', REGIONID: 'VIC1', PERIODTYPE: 'ACTUAL', RRP: 10 },
    ]
    const slots = toSlots(rows)
    expect(slots).toHaveLength(1)
    expect(slots[0].start.toISOString()).toBe('2026-10-29T05:30:00.000Z')
    expect(slots[0].price).toBe(-34.89)
  })
})
