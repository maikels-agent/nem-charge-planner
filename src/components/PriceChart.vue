<script setup>
import { computed } from 'vue'
import { centsPerKwh, fmtCents, fmtDayTime, fmtTime } from '../lib/format.js'

const props = defineProps({
  plan: { type: Array, required: true },
  deadline: { type: Date, required: true },
})

const W = 800
const H = 220
const PAD = { top: 10, right: 10, bottom: 28, left: 44 }

const geometry = computed(() => {
  const prices = props.plan.map((s) => centsPerKwh(s.price))
  const max = Math.max(5, ...prices)
  const min = Math.min(0, ...prices)
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const y = (v) => PAD.top + ((max - v) / (max - min)) * innerH
  const bw = innerW / props.plan.length
  const t0 = props.plan[0]?.start.getTime() ?? 0
  const t1 = props.plan.at(-1)?.end.getTime() ?? 1
  const x = (d) => PAD.left + ((d.getTime() - t0) / (t1 - t0)) * innerW
  const bars = props.plan.map((s, i) => {
    const v = centsPerKwh(s.price)
    return {
      x: PAD.left + i * bw + 1,
      y: Math.min(y(v), y(0)),
      w: Math.max(1, bw - 2),
      h: Math.max(1, Math.abs(y(v) - y(0))),
      charging: s.kwh > 0,
      label: `${fmtDayTime(s.start)}: ${fmtCents(v)}/kWh${s.kwh > 0 ? `, charge ${s.kwh.toFixed(1)} kWh` : ''}`,
    }
  })
  const ticks = niceTicks(min, max).map((v) => ({ v, y: y(v) }))
  const hours = props.plan
    .filter((s, i) => s.start.getMinutes() === 0 && s.start.getHours() % 6 === 0 && i > 0)
    .map((s) => ({ x: x(s.start), label: s.start.getHours() === 0 ? fmtDayTime(s.start).split(' ')[0] : fmtTime(s.start) }))
  const deadlineX = props.deadline.getTime() < t1 ? x(props.deadline) : null
  return { bars, ticks, hours, zeroY: y(0), deadlineX }
})

function niceTicks(min, max) {
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((s) => (max - min) / s <= 5) ?? 2000
  const ticks = []
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v)
  return ticks
}
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" class="chart" role="img" aria-label="Forecast price per half hour">
    <g class="grid">
      <g v-for="t in geometry.ticks" :key="t.v">
        <line :x1="PAD.left" :x2="W - PAD.right" :y1="t.y" :y2="t.y" />
        <text :x="PAD.left - 6" :y="t.y + 4" text-anchor="end">{{ t.v }}c</text>
      </g>
      <g v-for="h in geometry.hours" :key="h.x">
        <text :x="h.x" :y="H - 8" text-anchor="middle">{{ h.label }}</text>
      </g>
    </g>
    <rect
      v-for="(b, i) in geometry.bars"
      :key="i"
      :x="b.x" :y="b.y" :width="b.w" :height="b.h"
      :class="b.charging ? 'bar charging' : 'bar'"
    ><title>{{ b.label }}</title></rect>
    <line class="zero" :x1="PAD.left" :x2="W - PAD.right" :y1="geometry.zeroY" :y2="geometry.zeroY" />
    <g v-if="geometry.deadlineX !== null" class="deadline">
      <line :x1="geometry.deadlineX" :x2="geometry.deadlineX" :y1="PAD.top" :y2="H - PAD.bottom" />
      <text :x="geometry.deadlineX - 4" :y="PAD.top + 10" text-anchor="end">deadline</text>
    </g>
  </svg>
</template>
