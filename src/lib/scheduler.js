const MINUTE = 60 * 1000

function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

// Expands blocked periods into concrete [start, end) ranges covering
// the window. Daily blocks use the browser's local time and may wrap
// past midnight (e.g. 22:00–06:00).
export function expandBlocks(blocks, from, to) {
  const ranges = []
  for (const b of blocks) {
    if (b.type === 'once') {
      const start = new Date(b.start)
      const end = new Date(b.end)
      if (end > start) ranges.push([start, end])
      continue
    }
    const [sh, sm] = b.from.split(':').map(Number)
    const [eh, em] = b.to.split(':').map(Number)
    const day = new Date(from)
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - 1) // catch blocks wrapping in from yesterday
    while (day < to) {
      const days = b.days ?? [0, 1, 2, 3, 4, 5, 6]
      if (days.includes(day.getDay())) {
        const start = new Date(day)
        start.setHours(sh, sm, 0, 0)
        const end = new Date(day)
        end.setHours(eh, em, 0, 0)
        if (end <= start) end.setDate(end.getDate() + 1)
        ranges.push([start, end])
      }
      day.setDate(day.getDate() + 1)
    }
  }
  return ranges
}

// Minutes of a slot that can be used: after now, before the deadline
// and outside every blocked range.
export function usableMinutes(slot, now, deadline, blockRanges) {
  const start = new Date(Math.max(slot.start, now))
  const end = new Date(Math.min(slot.end, deadline))
  if (end <= start) return 0
  // Block ranges may overlap each other, so merge them before subtracting.
  const clipped = blockRanges
    .map(([s, e]) => [Math.max(s, start), Math.min(e, end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
  let blocked = 0
  let cursor = start.getTime()
  for (const [s, e] of clipped) {
    blocked += overlapMs(cursor, e, s, e)
    cursor = Math.max(cursor, e)
  }
  return (end - start - blocked) / MINUTE
}

// Picks the cheapest usable slots until enough energy is scheduled.
// Charging at a constant rate makes this a fractional knapsack, so
// greedy by price is optimal.
export function planCharging({ slots, now, deadline, energyKwh, powerKw, blocks = [] }) {
  const blockRanges = expandBlocks(blocks, now, deadline)
  const candidates = slots
    .map((slot) => {
      const minutes = usableMinutes(slot, now, deadline, blockRanges)
      return { ...slot, maxKwh: (powerKw * minutes) / 60 }
    })
    .filter((s) => s.maxKwh > 0)

  let remaining = energyKwh
  const kwhBySlot = new Map()
  for (const s of [...candidates].sort((a, b) => a.price - b.price)) {
    if (remaining <= 1e-9) break
    const kwh = Math.min(remaining, s.maxKwh)
    kwhBySlot.set(s.start.getTime(), kwh)
    remaining -= kwh
  }

  const plan = slots.map((s) => ({ ...s, kwh: kwhBySlot.get(s.start.getTime()) ?? 0 }))
  const scheduled = plan.filter((s) => s.kwh > 0)
  // $/MWh × kWh / 1000 = $
  const wholesaleCost = scheduled.reduce((sum, s) => sum + (s.price * s.kwh) / 1000, 0)
  const scheduledKwh = energyKwh - Math.max(0, remaining)
  const forecastEnd = slots.length ? slots[slots.length - 1].end : now

  return {
    plan,
    windows: mergeWindows(scheduled),
    scheduledKwh,
    shortfallKwh: Math.max(0, remaining),
    wholesaleCost,
    averagePrice: scheduledKwh > 0 ? (wholesaleCost * 1000) / scheduledKwh : 0,
    deadlineBeyondForecast: deadline > forecastEnd,
  }
}

// Joins back-to-back charging slots into windows you can set on a charger.
export function mergeWindows(scheduled) {
  const windows = []
  for (const s of [...scheduled].sort((a, b) => a.start - b.start)) {
    const last = windows[windows.length - 1]
    if (last && last.end.getTime() === s.start.getTime()) {
      last.end = s.end
      last.kwh += s.kwh
      last.cost += (s.price * s.kwh) / 1000
    } else {
      windows.push({ start: s.start, end: s.end, kwh: s.kwh, cost: (s.price * s.kwh) / 1000 })
    }
  }
  return windows
}
