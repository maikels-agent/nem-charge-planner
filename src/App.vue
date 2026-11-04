<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import BlockEditor from './components/BlockEditor.vue'
import PriceChart from './components/PriceChart.vue'
import { fetchForecast } from './lib/aemo.js'
import { planCharging } from './lib/scheduler.js'
import { centsPerKwh, fmtCents, fmtDayTime, fmtDollars, fmtTime } from './lib/format.js'
import { loadSettings, saveSettings } from './lib/storage.js'

const REFRESH_MS = 5 * 60 * 1000

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const settings = reactive({
  // 'battery' works out the energy from the charge level; 'energy' takes a fixed amount.
  mode: 'battery',
  capacityKwh: 50,
  socPct: 20,
  targetPct: 80,
  energyKwh: 20,
  powerKw: 7,
  // Empty means "end of the forecast".
  deadline: '',
  extraCents: 0,
  blocks: [],
  ...loadSettings(),
})
// A saved deadline that has passed is no use; fall back to the default.
if (settings.deadline && new Date(settings.deadline) <= new Date()) settings.deadline = ''
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

const forecastEnd = computed(() => slots.value.at(-1)?.end)
const deadline = computed(() => (settings.deadline ? new Date(settings.deadline) : forecastEnd.value))

const result = computed(() => {
  if (!slots.value.length || !deadline.value || isNaN(deadline.value)) return null
  return planCharging({
    slots: slots.value,
    now: now.value,
    deadline: deadline.value,
    energyKwh: Number(settings.energyKwh) || 0,
    powerKw: Number(settings.powerKw) || 0,
    battery: settings.mode === 'battery' && settings.capacityKwh > 0
      ? {
          capacityKwh: Number(settings.capacityKwh),
          socPct: Number(settings.socPct) || 0,
          targetPct: Number(settings.targetPct) || 0,
        }
      : null,
    blocks: settings.blocks.filter((b) => (b.type === 'once' ? b.start && b.end : b.from && b.to)),
  })
})

const finalPct = computed(() => result.value?.levels?.at(-1)?.pct)

const totalCost = computed(() =>
  result.value ? result.value.wholesaleCost + (settings.extraCents / 100) * result.value.scheduledKwh : 0,
)
</script>

<template>
  <main>
    <header>
      <h1>NEM Charge Planner</h1>
      <p class="sub">Cheapest times to use power in Victoria, based on AEMO's wholesale price forecast.</p>
    </header>

    <form class="card" @submit.prevent>
      <div class="mode" role="radiogroup" aria-label="How to work out the energy needed">
        <label><input v-model="settings.mode" type="radio" value="battery" /> From battery level</label>
        <label><input v-model="settings.mode" type="radio" value="energy" /> Fixed amount</label>
      </div>
      <div v-if="settings.mode === 'battery'" class="row">
        <label>Battery capacity
          <span class="unit"><input v-model.number="settings.capacityKwh" type="number" min="1" step="1" /> kWh</span>
        </label>
        <label>Charge now
          <span class="unit"><input v-model.number="settings.socPct" type="number" min="0" max="100" step="1" /> %</span>
        </label>
        <label>Charge target
          <span class="unit"><input v-model.number="settings.targetPct" type="number" min="0" max="100" step="1" /> %</span>
        </label>
      </div>
      <div class="row">
        <label v-if="settings.mode === 'energy'">Energy needed
          <span class="unit"><input v-model.number="settings.energyKwh" type="number" min="0" step="0.5" /> kWh</span>
        </label>
        <label>Charger power
          <span class="unit"><input v-model.number="settings.powerKw" type="number" min="0.1" step="0.1" /> kW</span>
        </label>
        <label>Needed by
          <input
            v-model="settings.deadline"
            type="datetime-local"
            :max="forecastEnd && toLocalInput(forecastEnd)"
          />
          <span v-if="!settings.deadline" class="field-hint">
            End of forecast<template v-if="forecastEnd"> ({{ fmtDayTime(forecastEnd) }})</template>
          </span>
          <button v-else type="button" class="link" @click="settings.deadline = ''">
            Use end of forecast
          </button>
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
            <span>
              scheduled<template v-if="result.blockKwh > 0">, incl. {{ result.blockKwh.toFixed(1) }} kWh
                for {{ result.blockCount }} {{ result.blockCount === 1 ? 'block' : 'blocks' }}</template>
            </span>
          </div>
          <div v-if="finalPct !== undefined">
            <strong>{{ Math.round(finalPct) }}%</strong>
            <span>battery at the deadline</span>
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

        <p v-for="s in result.shortfalls" :key="s.time.getTime()" class="warn">
          <template v-if="s.trip">
            Not enough charge for the trip at {{ fmtDayTime(s.time) }}: {{ s.kwh.toFixed(1) }} kWh short.
          </template>
          <template v-else>
            Can't fit {{ s.kwh.toFixed(1) }} kWh before the deadline at {{ settings.powerKw }} kW
            <template v-if="result.deadlineBeyondForecast">within the forecast period</template>.
          </template>
        </p>
        <p v-if="result.deadlineBeyondForecast" class="warn">
          Your deadline is after the end of the forecast ({{ fmtDayTime(forecastEnd) }}). The plan only uses
          forecast hours. Check again later for a longer forecast.
        </p>

        <PriceChart :plan="result.plan" :deadline="deadline" :levels="result.levels" />

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
