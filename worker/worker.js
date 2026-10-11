import { DurableObject } from 'cloudflare:workers'
import { validate } from '../state.js'

const MAX_EVENTS = 200
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const json = (body, status = 200) => Response.json(body, { status })

// One instance holds the recent event log. Methods only await storage, so calls can't interleave.
export class Relay extends DurableObject {
  async add(ev) {
    const s = (await this.ctx.storage.get('log')) || { seq: 0, events: [] }
    const now = Date.now()
    s.events = [...s.events.filter((e) => now - e.ts < MAX_AGE_MS), { ...ev, seq: ++s.seq, ts: now }].slice(-MAX_EVENTS)
    await this.ctx.storage.put('log', s)
  }
  async since(n) {
    const s = (await this.ctx.storage.get('log')) || { seq: 0, events: [] }
    return { seq: s.seq, events: s.events.filter((e) => e.seq > n) }
  }
}

async function authorized(req, env) {
  const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!env.TOKEN) return false
  const hash = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return crypto.subtle.timingSafeEqual(await hash(given), await hash(env.TOKEN))
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (!(await authorized(req, env))) return json({ ok: false, error: 'unauthorized' }, 401)
    const relay = env.RELAY.get(env.RELAY.idFromName('main'))

    if (req.method === 'POST' && url.pathname === '/event') {
      const text = await req.text()
      if (text.length > 4096) return json({ ok: false, error: 'body too large' }, 413)
      let ev
      try { ev = validate(JSON.parse(text)) } catch {}
      // idle/end are internal to the desktop app, not part of the public API
      if (!ev || !['start', 'needs_input', 'done', 'failed'].includes(ev.status))
        return json({ ok: false, error: 'need agent (instinct|muse), task_id, status (start|needs_input|done|failed)' }, 400)
      await relay.add(ev)
      return json({ ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/events')
      return json(await relay.since(Number(url.searchParams.get('since')) || 0))
    return json({ ok: false, error: 'not found' }, 404)
  },
}
