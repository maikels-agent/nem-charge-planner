<script setup>
const blocks = defineModel({ type: Array, required: true })

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function addDaily() {
  blocks.value.push({ type: 'daily', from: '08:00', to: '18:00', days: [1, 2, 3, 4, 5], kwh: 0 })
}

function addOnce() {
  blocks.value.push({ type: 'once', start: '', end: '', kwh: 0 })
}

function toggleDay(block, day) {
  block.days = block.days.includes(day)
    ? block.days.filter((d) => d !== day)
    : [...block.days, day].sort()
}
</script>

<template>
  <fieldset>
    <legend>Times you can't charge</legend>
    <p v-if="!blocks.length" class="hint">None. Charging can happen any time before the deadline.</p>
    <div v-for="(block, i) in blocks" :key="i" class="block">
      <template v-if="block.type === 'daily'">
        <span class="tag">Every week</span>
        <input v-model="block.from" type="time" aria-label="From" />
        <span>to</span>
        <input v-model="block.to" type="time" aria-label="To" />
        <div class="days">
          <button
            v-for="(name, d) in DAYS"
            :key="d"
            type="button"
            :class="{ on: block.days.includes(d) }"
            @click="toggleDay(block, d)"
          >{{ name }}</button>
        </div>
      </template>
      <template v-else>
        <span class="tag">Once</span>
        <input v-model="block.start" type="datetime-local" aria-label="From" />
        <span>to</span>
        <input v-model="block.end" type="datetime-local" aria-label="To" />
      </template>
      <label class="uses">
        uses
        <input v-model.number="block.kwh" type="number" min="0" step="0.5" placeholder="0" />
        kWh
      </label>
      <button type="button" class="remove" aria-label="Remove" @click="blocks.splice(i, 1)">✕</button>
    </div>
    <div class="actions">
      <button type="button" @click="addDaily">+ Weekly block</button>
      <button type="button" @click="addOnce">+ One-off block</button>
    </div>
  </fieldset>
</template>
