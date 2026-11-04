const time = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit' })
const dayTime = new Intl.DateTimeFormat('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })

export const fmtTime = (d) => time.format(d)
export const fmtDayTime = (d) => dayTime.format(d)
// $/MWh → c/kWh
export const centsPerKwh = (dollarsPerMwh) => dollarsPerMwh / 10
export const fmtCents = (c) => `${c.toFixed(1)}c`
export const fmtDollars = (d) => `${d < 0 ? '-' : ''}$${Math.abs(d).toFixed(2)}`
