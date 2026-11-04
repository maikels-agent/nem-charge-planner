const MINUTE = 60 * 1000

function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

// Expands blocked periods into concrete [start, end, kwh] ranges covering
// the window, where kwh is the energy used during that occurrence (e.g. a
// commute). Daily blocks use the browser's local time and may wrap past
// midnight (e.g. 22:00–06:00).
export function expandBlocks(blocks, from, to) {
  const ranges = []
  for (const b of blocks) {
    const kwh = Number(b.kwh) || 0
    if (b.type === 'once') {
      const start = new Date(b.start)
      const end = new Date(b.end)
      if (end > start) ranges.push([start, end, kwh])
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
        ranges.push([start, end, kwh])
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

// Energy used during blocked periods that overlap the window from now
// until the deadline. That energy has to be charged on top.
export function blockEnergy(blockRanges, now, deadline) {
  const used = blockRanges.filter(([s, e, kwh]) => kwh > 0 && e > now && s < deadline)
  return {
    kwh: used.reduce((sum, [, , kwh]) => sum + kwh, 0),
    count: used.length,
  }
}

const EPS = 1e-9

// Plans charging in the cheapest usable slots.
//
// Without `battery`, energyKwh plus the energy used in blocks just has to
// be charged by the deadline: picking the cheapest slots first is optimal.
//
// With `battery` ({ capacityKwh, socPct, targetPct }) the battery level is
// tracked: each trip (a block that uses energy) must have its energy in
// the battery when it starts, the level may never exceed capacity, and the
// battery must be at the target by the deadline. Requirements are met in
// time order, each from the cheapest slots before it that still have room.
export function planCharging({ slots, now, deadline, energyKwh = 0, powerKw, blocks = [], battery = null }) {
  const blockRanges = expandBlocks(blocks, now, deadline)
  const blockUse = blockEnergy(blockRanges, now, deadline)
  const candidates = slots.map((slot) => {
    const minutes = usableMinutes(slot, now, deadline, blockRanges)
    return { ...slot, maxKwh: (powerKw * minutes) / 60, kwh: 0 }
  })

  let initialKwh = 0
  let capacityKwh = Infinity
  let trips = []
  let requirements
  if (battery) {
    capacityKwh = battery.capacityKwh
    initialKwh = (capacityKwh * Math.min(100, battery.socPct)) / 100
    const targetKwh = (capacityKwh * Math.min(100, battery.targetPct)) / 100
    // A trip already under way is left out: the current level is what
    // the battery has now, wherever the car is.
    trips = blockRanges
      .filter(([s, , kwh]) => kwh > 0 && s >= now && s < deadline)
      .map(([s, , kwh]) => ({ time: s, kwh }))
      .sort((a, b) => a.time - b.time)
    let used = 0
    requirements = trips.map((trip) => {
      used += trip.kwh
      return { time: trip.time, needed: used - initialKwh, trip }
    })
    requirements.push({ time: deadline, needed: targetKwh + used - initialKwh })
  } else {
    requirements = [{ time: deadline, needed: energyKwh + blockUse.kwh }]
  }

  const chargedBefore = (t) => candidates.reduce((sum, c) => (c.start < t ? sum + c.kwh : sum), 0)
  const usedBefore = (t) => trips.reduce((sum, trip) => (trip.time < t ? sum + trip.kwh : sum), 0)
  // The level peaks at the end of a slot or just before a trip leaves.
  const checkpoints = [...candidates.map((c) => c.end), ...trips.map((trip) => trip.time)]
  // How much more can go into a slot without overfilling the battery later.
  const headroom = (slot) => {
    if (capacityKwh === Infinity) return Infinity
    return checkpoints
      .filter((t) => t > slot.start)
      .reduce((min, t) => Math.min(min, capacityKwh - (initialKwh + chargedBefore(t) - usedBefore(t))), Infinity)
  }

  for (const req of requirements) {
    let need = req.needed - chargedBefore(req.time)
    if (need <= EPS) continue
    const options = candidates
      .filter((c) => c.start < req.time && c.maxKwh - c.kwh > EPS)
      .sort((a, b) => a.price - b.price)
    for (const c of options) {
      if (need <= EPS) break
      const kwh = Math.min(need, c.maxKwh - c.kwh, headroom(c))
      if (kwh <= EPS) continue
      c.kwh += kwh
      need -= kwh
    }
  }

  const shortfalls = requirements
    .map((req) => ({ time: req.time, trip: req.trip ?? null, kwh: req.needed - chargedBefore(req.time) }))
    .filter((s) => s.kwh > 0.05)
  const final = requirements[requirements.length - 1]

  const plan = candidates.map(({ maxKwh, ...slot }) => slot)
  const scheduled = plan.filter((s) => s.kwh > 0)
  // $/MWh × kWh / 1000 = $
  const wholesaleCost = scheduled.reduce((sum, s) => sum + (s.price * s.kwh) / 1000, 0)
  const scheduledKwh = scheduled.reduce((sum, s) => sum + s.kwh, 0)
  const forecastEnd = slots.length ? slots[slots.length - 1].end : now

  return {
    plan,
    totalKwh: Math.max(0, final.needed),
    blockKwh: battery ? trips.reduce((sum, trip) => sum + trip.kwh, 0) : blockUse.kwh,
    blockCount: battery ? trips.length : blockUse.count,
    windows: mergeWindows(scheduled),
    scheduledKwh,
    shortfallKwh: Math.max(0, final.needed - chargedBefore(final.time)),
    shortfalls,
    wholesaleCost,
    averagePrice: scheduledKwh > 0 ? (wholesaleCost * 1000) / scheduledKwh : 0,
    deadlineBeyondForecast: deadline > forecastEnd,
    levels: battery ? batteryLevels(plan, trips, initialKwh, capacityKwh, now, deadline) : null,
  }
}

// Battery level (%) over time for the chart. Charging is spread evenly
// over each slot; trips take their energy when they start.
export function batteryLevels(plan, trips, initialKwh, capacityKwh, now, deadline) {
  const levelAt = (t, includeTripsAt) => {
    let level = initialKwh
    for (const s of plan) {
      if (s.kwh <= 0) continue
      const from = Math.max(s.start, now)
      const frac = Math.min(1, Math.max(0, (t - from) / (s.end - from)))
      level += s.kwh * frac
    }
    for (const trip of trips) {
      if (trip.time < t || (includeTripsAt && trip.time.getTime() === t.getTime())) level -= trip.kwh
    }
    return (level / capacityKwh) * 100
  }
  const end = Math.min(deadline, plan.length ? plan[plan.length - 1].end : now)
  const points = [{ time: now, pct: levelAt(now, false) }]
  const times = plan.map((s) => s.end).filter((t) => t > now && t <= end)
  for (const t of times) points.push({ time: t, pct: levelAt(t, true) })
  for (const trip of trips) {
    if (trip.time > end) continue
    points.push({ time: trip.time, pct: levelAt(trip.time, false), pre: true })
    points.push({ time: trip.time, pct: levelAt(trip.time, true) })
  }
  return points.sort((a, b) => a.time - b.time || (b.pre ? 1 : 0) - (a.pre ? 1 : 0)).map(({ time, pct }) => ({ time, pct }))
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
