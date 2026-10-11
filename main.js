const { app, BrowserWindow, Tray, Menu, ipcMain, screen } = require('electron')
const http = require('http')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const { apply, fromClaudeHook } = require('./state')

const PORT = 4747
const POLL_MS = 5000 // ponytail: polling the relay; switch to a WebSocket if 5s lag matters
const sessions = new Map()
let win, tray, anchor // anchor = the widget's bottom-left corner

const logos = Object.fromEntries(
  fs.readdirSync(path.join(__dirname, 'logos'))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => [path.basename(f, '.svg'), fs.readFileSync(path.join(__dirname, 'logos', f), 'utf8')])
)

const push = () => win?.webContents.send('state', { logos, sessions: [...sessions.values()] })
const ingest = (ev) => apply(sessions, ev) && (push(), true)

// --- local server: Claude Code hooks and the Chrome extension post here ---
http.createServer((req, res) => {
  const end = (code, body = '') => res.writeHead(code).end(body)
  // Requiring JSON forces a CORS preflight, so random web pages can't post fake statuses.
  if (req.method !== 'POST' || !/^application\/json/.test(req.headers['content-type'] || '')) return end(404)
  let body = ''
  req.on('data', (c) => { if ((body += c).length > 2e6) req.destroy() })
  req.on('end', () => {
    let json
    try { json = JSON.parse(body) } catch { return end(400) }
    if (process.env.HOOK_LOG) fs.appendFileSync(process.env.HOOK_LOG, body + '\n') // debug: raw payloads
    try { // an unexpected payload must never pop Electron's crash dialog
      if (req.url === '/hook/claude') return ingest(fromClaudeHook(json)), end(204) // empty reply: hook stdout would land in Claude's context
      if (req.url === '/event') return ingest(json) ? end(200, '{"ok":true}') : end(400, '{"ok":false}')
      end(404)
    } catch (e) { console.error(e); end(500) }
  })
}).listen(PORT, '127.0.0.1')

// --- relay: Instinct and Muse post to the Cloudflare worker, we pull from it ---
function pollRelay() {
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(path.join(app.isPackaged ? app.getPath('userData') : __dirname, 'config.json'), 'utf8')) } catch { return }
  if (!cfg.relayUrl || !cfg.token) return
  let since = 0, first = true
  const tick = async () => {
    try {
      const r = await fetch(`${cfg.relayUrl}/events?since=${since}`, { headers: { Authorization: `Bearer ${cfg.token}` } })
      if (!r.ok) throw new Error(`relay ${r.status}`)
      const { seq, events } = await r.json()
      since = seq
      events.forEach((ev) => apply(sessions, ev))
      // On startup the relay replays the last 24h; keep only tasks that are still in flight.
      if (first) for (const [k, s] of sessions) if (s.agent !== 'claude' && s.agent !== 'gemini' && !['working', 'needs_input'].includes(s.status)) sessions.delete(k)
      first = false
      if (events.length) push()
    } catch (e) { console.error(e.message) }
    setTimeout(tick, POLL_MS)
  }
  tick()
}

// Auto-dismiss tasks that have sat on "done" for 20 minutes (unless background tasks are still running).
const DONE_TTL_MS = 20 * 60 * 1000
setInterval(() => {
  let changed = false
  for (const [k, s] of sessions) {
    const busy = (s.tasks || []).some((t) => t.status === 'working')
    if (s.status === 'done' && !busy && !s.pinned && Date.now() - s.updated > DONE_TTL_MS) changed = sessions.delete(k)
  }
  if (changed) push()
}, 60000)

// PR badge: for a known PR, refresh its state; otherwise ask gh for the PR of the branch checked out
// in the session's folder (no PR / not a repo / no gh = error, ignored).
function pollPr() {
  for (const s of sessions.values()) {
    if (s.agent !== 'claude' || s.pr?.state === 'merged' || (!s.pr && !s.cwd)) continue
    const args = ['pr', 'view', ...(s.pr ? [s.pr.url] : []), '--json', 'url,state,mergeable']
    execFile('gh', args, { cwd: s.cwd, timeout: 20000 }, (err, out) => {
      if (err) return
      let r
      try { r = JSON.parse(out) } catch { return }
      const before = s.pr && s.pr.state
      if (r.state === 'CLOSED') delete s.pr
      else s.pr = { url: s.pr ? s.pr.url : r.url, state: r.state === 'MERGED' ? 'merged' : r.mergeable === 'CONFLICTING' ? 'conflict' : 'open' }
      if ((s.pr && s.pr.state) !== before) push()
    })
  }
}
setInterval(pollPr, 30000)

function createWindow() {
  // Windows: sits on the empty left end of the taskbar (assumes centred taskbar icons).
  // Elsewhere: bottom-left of the work area, so it clears the dock / panel.
  const dock = () => {
    const d = screen.getPrimaryDisplay()[process.platform === 'win32' ? 'bounds' : 'workArea']
    anchor = { x: d.x + 8, bottom: d.y + d.height - 2 }
  }
  dock()
  win = new BrowserWindow({
    width: 120, height: 44, x: anchor.x, y: anchor.bottom - 44,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // ponytail: the taskbar is topmost too and jumps in front whenever it's clicked, so re-raise on a timer.
  // Truly embedding in the taskbar needs unsupported explorer.exe hacks on Windows 11.
  if (process.platform === 'win32') setInterval(() => win.isVisible() && win.moveTop(), 1000)
  win.loadFile('index.html')
  // will-move only fires for user drags, so our own setBounds calls don't move the anchor
  let dragging = false
  win.on('will-move', () => { dragging = true })
  win.on('moved', () => {
    if (!dragging) return
    dragging = false
    const b = win.getBounds()
    anchor = { x: b.x, bottom: b.y + b.height }
  })
  // Resolution or scaling changed (docking, projector, new monitor): the old anchor may now be
  // off-screen, so snap back to the taskbar's left end.
  const redock = () => {
    dock()
    const { width, height } = win.getBounds()
    win.setBounds({ x: anchor.x, y: anchor.bottom - height, width, height })
  }
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, redock)

  tray = new Tray(path.join(__dirname, 'tray.png'))
  tray.setToolTip('Agent Dock')
  const toggle = () => (win.isVisible() ? win.hide() : win.show())
  tray.on('click', toggle)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: toggle },
    { label: 'Clear finished', click: () => { for (const [k, s] of sessions) if (['done', 'failed'].includes(s.status)) sessions.delete(k); push() } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]))
}

ipcMain.on('ready', push)
ipcMain.on('dismiss', (_e, key) => { sessions.delete(key); push() })
ipcMain.on('pin', (_e, key, on) => { const s = sessions.get(key); if (s) { s.pinned = !!on; push() } })
ipcMain.on('minimize', () => win.hide())
// The window hugs its content so the transparent area never eats clicks; bottom-left corner stays put.
// The anchor is tracked here rather than read back with getBounds(): at 125% display scaling
// that round-trip drifts a pixel or two per resize.
ipcMain.on('resize', (_e, w, h) => {
  w = Math.ceil(w); h = Math.ceil(h)
  win.setBounds({ x: anchor.x, y: anchor.bottom - h, width: w, height: h })
})

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => win?.show())
  app.whenReady().then(() => {
    app.dock?.hide() // macOS: tray-only, no Dock icon
    // Dev mode has to relaunch electron with the app path; a packaged app is its own executable.
    if (process.platform !== 'linux') app.setLoginItemSettings(app.isPackaged ? { openAtLogin: true } : { openAtLogin: true, path: process.execPath, args: [app.getAppPath()] })
    createWindow()
    pollRelay()
  })
  app.on('window-all-closed', () => {}) // keep running in the tray
}
