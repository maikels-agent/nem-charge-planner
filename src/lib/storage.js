const KEY = 'nem-charge-planner:settings'

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? null
  } catch {
    return null
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Storage can be unavailable (private mode); settings just won't persist.
  }
}
