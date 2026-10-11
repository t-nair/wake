// Shared by the Electron app and the Cloudflare worker: keep it free of Node-only requires.
const AGENTS = ['claude', 'gemini', 'muse', 'instinct']
// start/needs_input/done/failed are the public API; idle, end and keep are used by the Claude hooks.
const STATUSES = { start: 'working', needs_input: 'needs_input', done: 'done', failed: 'failed', idle: 'idle', end: 'end', keep: 'keep' }
const MAX_TASKS = 20

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : undefined)

// Returns a cleaned event, or null if it is not one we accept.
function validate(ev) {
  if (!ev || typeof ev !== 'object') return null
  const task_id = clip(String(ev.task_id ?? ''), 200)
  if (!AGENTS.includes(ev.agent) || !Object.hasOwn(STATUSES, ev.status) || !task_id) return null
  return { agent: ev.agent, task_id, status: ev.status, name: clip(ev.name, 120), detail: clip(ev.detail, 500) }
}

// Mutates sessions (a Map keyed "agent:task_id"). Returns false if the event was rejected.
function apply(sessions, raw, now = Date.now()) {
  const ev = validate(raw)
  if (!ev) return false
  const key = `${ev.agent}:${ev.task_id}`
  if (ev.status === 'end') return sessions.delete(key), true
  const prev = sessions.get(key) || {}
  sessions.set(key, {
    key,
    agent: ev.agent,
    status: ev.status === 'keep' ? prev.status || 'working' : STATUSES[ev.status],
    tasks: mergeTask(prev.tasks || [], raw.task, now),
    pinned: !!prev.pinned, // user toggle in the widget: exempt from auto-dismiss
    name: ev.name || prev.name || clip(raw.defaultName, 120) || ev.task_id,
    detail: ev.detail ?? prev.detail ?? '',
    updated: now,
  })
  return true
}

// Background tasks (subagents, background commands) inside a session. An update without a
// kind only touches a task we already know about.
function mergeTask(tasks, t, now) {
  if (!t || !t.id) return tasks
  const old = tasks.find((x) => x.id === t.id)
  if (!old && !t.kind) return tasks
  const kind = old ? old.kind : t.kind
  const merged = {
    id: String(t.id),
    kind,
    name: clip(t.name, 120) || (old && old.name) || kind,
    detail: clip(t.detail, 300) ?? (old && old.detail) ?? '',
    status: t.status || (old && old.status) || 'working',
    updated: now,
  }
  return [...tasks.filter((x) => x.id !== t.id), merged].slice(-MAX_TASKS)
}

const NOTIFICATION = /^<task-notification>[\s\S]*?<task-id>(.*?)<\/task-id>[\s\S]*?<status>(.*?)<\/status>(?:[\s\S]*?<summary>([\s\S]*?)<\/summary>)?/

// Maps a Claude Code hook payload to an event. Null means "ignore".
function fromClaudeHook(h) {
  if (!h || !h.session_id) return null
  const ev = {
    agent: 'claude',
    task_id: h.session_id,
    name: h.session_title, // only some events carry it, so the folder name is just a fallback
    defaultName: String(h.cwd || '').split(/[\\/]/).filter(Boolean).pop(),
  }
  const i = h.tool_input || {}
  const what = i.description || i.command || i.file_path || i.pattern || ''
  const toolDetail = `${h.tool_name}${what ? ': ' + what : ''}`

  if (h.agent_id) { // fired by or inside a subagent: update its task row, leave the session alone
    const task = { id: h.agent_id, kind: 'agent', name: h.agent_type }
    switch (h.hook_event_name) {
      case 'SubagentStart': return { ...ev, status: 'keep', task: { ...task, status: 'working' } }
      case 'SubagentStop': return { ...ev, status: 'keep', task: { ...task, status: 'done', detail: h.last_assistant_message } }
      case 'PreToolUse': return { ...ev, status: 'keep', task: { ...task, detail: toolDetail } }
      default: return null
    }
  }

  switch (h.hook_event_name) {
    case 'SessionStart': return { ...ev, status: 'idle', detail: 'Session started' }
    case 'UserPromptSubmit': {
      // A finished background task re-enters the session as a synthetic prompt.
      const n = NOTIFICATION.exec(h.prompt || '')
      if (!n) return { ...ev, status: 'start', detail: h.prompt }
      const status = { completed: 'done', failed: 'failed' }[n[2]] || 'stopped'
      return { ...ev, status: 'start', task: { id: n[1], status, detail: n[3] } }
    }
    case 'PreToolUse': return { ...ev, status: 'start', detail: toolDetail }
    case 'PostToolUse': { // also clears yellow after a permission prompt is answered
      const bg = h.tool_response && h.tool_response.backgroundTaskId
      let task
      if (bg) task = { id: bg, kind: 'command', name: i.description || i.command, detail: i.command, status: 'working' }
      if (h.tool_name === 'TaskStop') task = { id: i.task_id || i.shell_id, status: 'stopped' }
      return { ...ev, status: 'start', task }
    }
    case 'Notification': return { ...ev, status: 'needs_input', detail: h.message }
    case 'Stop': return { ...ev, status: 'done', detail: h.last_assistant_message }
    case 'StopFailure': return { ...ev, status: 'failed', detail: h.error_type || h.error || h.message || 'Stopped with an error' }
    case 'SessionEnd': return { ...ev, status: 'end' }
    default: return null
  }
}

module.exports = { validate, apply, fromClaudeHook }
