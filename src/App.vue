<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import BlockEditor from './components/BlockEditor.vue'
import PriceChart from './components/PriceChart.vue'
import { fetchForecast } from './lib/aemo.js'
import { planCharging } from './lib/scheduler.js'
import { centsPerKwh, fmtCents, fmtDayTime, fmtDollars, fmtTime } from './lib/format.js'
import { loadSettings, saveSettings } from './lib/storage.js'

const REFRESH_MS = 5 * 60 * 1000

function defaultDeadline() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(7, 0, 0, 0)
  return toLocalInput(d)
}

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const settings = reactive({
  energyKwh: 20,
  powerKw: 7,
  deadline: defaultDeadline(),
  extraCents: 0,
  blocks: [],
  ...loadSettings(),
})
// A saved deadline that has passed is no use; roll it forward.
if (new Date(settings.deadline) <= new Date()) settings.deadline = defaultDeadline()
watch(settings, () => saveSettings(settings), { deep: true })

const slots = ref([])
const error = ref(null)
const loading = ref(false)
const fetchedAt = ref(null)
const now = ref(new Date())

async function refresh() {
  loading.value = true
  error.value = null
  try {
    slots.value = await fetchForecast('VIC1')
    fetchedAt.value = new Date()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
    now.value = new Date()
  }
}

let timer
onMounted(() => {
  refresh()
  timer = setInterval(refresh, REFRESH_MS)
})
onUnmounted(() => clearInterval(timer))

const deadline = computed(() => new Date(settings.deadline))

const result = computed(() => {
  if (!slots.value.length || isNaN(deadline.value)) return null
  return planCharging({
    slots: slots.value,
    now: now.value,
    deadline: deadline.value,
    energyKwh: Number(settings.energyKwh) || 0,
    powerKw: Number(settings.powerKw) || 0,
    blocks: settings.blocks.filter((b) => (b.type === 'once' ? b.start && b.end : b.from && b.to)),
  })
})

const totalCost = computed(() =>
  result.value ? result.value.wholesaleCost + (settings.extraCents / 100) * result.value.scheduledKwh : 0,
)
const forecastEnd = computed(() => slots.value.at(-1)?.end)
</script>

<template>
  <main>
    <header>
      <h1>NEM Charge Planner</h1>
      <p class="sub">Cheapest times to use power in Victoria, based on AEMO's wholesale price forecast.</p>
    </header>

    <form class="card" @submit.prevent>
      <div class="row">
        <label>Energy needed
          <span class="unit"><input v-model.number="settings.energyKwh" type="number" min="0" step="0.5" /> kWh</span>
        </label>
        <label>Charger power
          <span class="unit"><input v-model.number="settings.powerKw" type="number" min="0.1" step="0.1" /> kW</span>
        </label>
        <label>Needed by
          <input v-model="settings.deadline" type="datetime-local" />
        </label>
        <label>Network + retail extra
          <span class="unit"><input v-model.number="settings.extraCents" type="number" step="0.5" /> c/kWh</span>
        </label>
      </div>
      <BlockEditor v-model="settings.blocks" />
    </form>

    <section class="card">
      <div class="status">
        <span v-if="loading">Loading forecast…</span>
        <span v-else-if="error" class="error">Couldn't load the forecast: {{ error }}</span>
        <span v-else-if="fetchedAt">
          Forecast updated {{ fmtTime(fetchedAt) }}, covers until {{ fmtDayTime(forecastEnd) }}
        </span>
        <button type="button" :disabled="loading" @click="refresh">Refresh</button>
      </div>

      <template v-if="result">
        <div class="summary">
          <div>
            <strong>{{ result.scheduledKwh.toFixed(1) }} kWh</strong>
            <span>scheduled</span>
          </div>
          <div>
            <strong>{{ fmtCents(centsPerKwh(result.averagePrice)) }}</strong>
            <span>avg wholesale per kWh</span>
          </div>
          <div>
            <strong>{{ fmtDollars(totalCost) }}</strong>
            <span>estimated cost</span>
          </div>
        </div>

        <p v-if="result.shortfallKwh > 0.05" class="warn">
          Can't fit {{ result.shortfallKwh.toFixed(1) }} kWh before the deadline at {{ settings.powerKw }} kW
          <template v-if="result.deadlineBeyondForecast">within the forecast period</template>.
        </p>
        <p v-if="result.deadlineBeyondForecast" class="warn">
          Your deadline is after the end of the forecast ({{ fmtDayTime(forecastEnd) }}). The plan only uses
          forecast hours. Check again later for a longer forecast.
        </p>

        <PriceChart :plan="result.plan" :deadline="deadline" />

        <h2>When to charge</h2>
        <p v-if="!result.windows.length" class="hint">Nothing scheduled.</p>
        <table v-else>
          <thead><tr><th>From</th><th>To</th><th>Energy</th><th>Wholesale</th></tr></thead>
          <tbody>
            <tr v-for="w in result.windows" :key="w.start.getTime()">
              <td>{{ fmtDayTime(w.start) }}</td>
              <td>{{ fmtTime(w.end) }}</td>
              <td>{{ w.kwh.toFixed(1) }} kWh</td>
              <td>{{ fmtDollars(w.cost) }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </section>

    <footer>
      Prices are AEMO's wholesale forecast for VIC1 (pre-dispatch, 30-minute periods) and change every
      half hour. Unless you're on a wholesale-linked plan, your retailer charges differently. Use the
      "extra" field to add your network and retail costs. Times are shown in your browser's time zone.
    </footer>
  </main>
</template>
