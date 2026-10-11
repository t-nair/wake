// ponytail: "is the stop button on screen" is the whole detector. If Google renames it, fix this selector.
// No needs-input/failed detection; add when Gemini exposes something sturdier than DOM.
const STOP_BUTTON = 'button[aria-label*="Stop" i]'
const task_id = crypto.randomUUID() // one logo per tab load
let working = false

setInterval(() => {
  const now = !!document.querySelector(STOP_BUTTON)
  if (now === working) return
  working = now
  const name = document.title.replace(/\s*[-|]\s*(Google )?Gemini\s*$/i, '') || 'Gemini chat'
  chrome.runtime.sendMessage({ agent: 'gemini', task_id, status: working ? 'start' : 'done', name, detail: location.href })
}, 1000)
