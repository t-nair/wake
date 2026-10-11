// Content scripts can't reach http://127.0.0.1 from an https page; the service worker can.
chrome.runtime.onMessage.addListener((event) => {
  fetch('http://127.0.0.1:4747/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  }).catch(() => {}) // widget not running
})
