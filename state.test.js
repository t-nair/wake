const assert = require('node:assert')
const { validate, apply, fromClaudeHook } = require('./state')

// validation
assert.equal(validate({ agent: 'nope', task_id: '1', status: 'start' }), null)
assert.equal(validate({ agent: 'instinct', task_id: '1', status: 'bogus' }), null)
assert.equal(validate({ agent: 'instinct', task_id: '', status: 'start' }), null)
assert.equal(validate({ agent: 'instinct', task_id: '1', status: 'toString' }), null)
assert.equal(validate({ agent: 'muse', task_id: 7, status: 'done', name: 'x'.repeat(500) }).name.length, 120)

// lifecycle: start -> needs_input -> done keeps the name, end removes
const s = new Map()
assert.ok(apply(s, { agent: 'instinct', task_id: 't1', status: 'start', name: 'Book dentist', detail: 'calling' }))
assert.equal(s.get('instinct:t1').status, 'working')
apply(s, { agent: 'instinct', task_id: 't1', status: 'needs_input', detail: 'Which day?' })
assert.deepEqual([s.get('instinct:t1').status, s.get('instinct:t1').name, s.get('instinct:t1').detail], ['needs_input', 'Book dentist', 'Which day?'])
apply(s, { agent: 'instinct', task_id: 't1', status: 'done' })
assert.deepEqual([s.get('instinct:t1').status, s.get('instinct:t1').detail], ['done', 'Which day?'])
assert.equal(apply(s, { agent: 'instinct', status: 'done' }), false)
apply(s, { agent: 'instinct', task_id: 't1', status: 'end' })
assert.equal(s.size, 0)

// Claude hook mapping
const base = { session_id: 'abc', cwd: 'C:\\Users\\me\\repos\\remora' }
const hook = (name, extra) => fromClaudeHook({ ...base, hook_event_name: name, ...extra })
assert.deepEqual(hook('SessionStart'), { agent: 'claude', task_id: 'abc', name: undefined, defaultName: 'remora', status: 'idle', detail: 'Session started' })
// folder name until a title shows up, then the title sticks even when later events omit it
const n = new Map()
apply(n, hook('SessionStart'))
assert.equal(n.get('claude:abc').name, 'remora')
apply(n, hook('UserPromptSubmit', { prompt: 'fix it', session_title: 'auth' }))
apply(n, hook('PreToolUse', { tool_name: 'Bash' }))
assert.equal(n.get('claude:abc').name, 'auth')
assert.equal(hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }).detail, 'Bash: npm test')
assert.equal(hook('Notification', { message: 'Claude needs permission' }).status, 'needs_input')
assert.equal(hook('Stop', { last_assistant_message: 'Done.' }).status, 'done')
assert.equal(hook('StopFailure').status, 'failed')
assert.equal(hook('SessionEnd').status, 'end')
assert.equal(hook('Stop', { agent_id: 'sub1' }), null)

// background tasks: command start -> notification, subagent start -> tool -> stop
const c = new Map()
const feed = (name, extra) => apply(c, hook(name, extra))
const tasks = () => c.get('claude:abc').tasks
feed('UserPromptSubmit', { prompt: 'go' })
feed('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run dev', description: 'Start dev server', run_in_background: true }, tool_response: { backgroundTaskId: 'bg1' } })
assert.deepEqual([tasks()[0].kind, tasks()[0].name, tasks()[0].status], ['command', 'Start dev server', 'working'])
feed('Stop', { last_assistant_message: 'Started it.' })
assert.equal(tasks().length, 1) // tasks survive the turn ending
feed('SubagentStart', { agent_id: 'sub1', agent_type: 'Explore' })
assert.equal(c.get('claude:abc').status, 'done') // subagent events don't change the session status
feed('PreToolUse', { agent_id: 'sub1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'TODO' } })
assert.deepEqual([tasks()[1].name, tasks()[1].detail, tasks()[1].status], ['Explore', 'Grep: TODO', 'working'])
assert.equal(c.get('claude:abc').detail, 'Started it.') // nor its detail
feed('SubagentStop', { agent_id: 'sub1', agent_type: 'Explore', last_assistant_message: 'Found 3.' })
assert.deepEqual([tasks()[1].status, tasks()[1].detail], ['done', 'Found 3.'])
feed('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>x</tool-use-id>\n<status>failed</status>\n<summary>Exited with code 1</summary>\n</task-notification>' })
const bg = tasks().find((x) => x.id === 'bg1')
assert.deepEqual([bg.status, bg.detail, c.get('claude:abc').status, c.get('claude:abc').detail], ['failed', 'Exited with code 1', 'working', 'Started it.'])
feed('UserPromptSubmit', { prompt: '<task-notification><task-id>unknown</task-id><status>completed</status></task-notification>' })
assert.equal(tasks().length, 2) // unknown ids don't create ghost rows
feed('PostToolUse', { tool_name: 'TaskStop', tool_input: { task_id: 'sub1' } })
assert.equal(tasks().find((x) => x.id === 'sub1').status, 'stopped')
assert.equal(hook('PostCompact'), null)

// PR created from the session is attached once; unrelated Bash output is ignored
const pr = new Map()
const prHook = (command, stdout) => apply(pr, hook('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout } }))
prHook('ls', 'https://github.com/o/r/pull/1')
assert.equal(pr.get('claude:abc').pr, undefined)
prHook('gh pr create --fill', 'https://github.com/o/r/pull/7')
assert.deepEqual(pr.get('claude:abc').pr, { url: 'https://github.com/o/r/pull/7', state: 'open' })
pr.get('claude:abc').pr.state = 'merged'
apply(pr, hook('Stop'))
assert.equal(pr.get('claude:abc').pr.state, 'merged') // later events keep the polled state

// the pin toggle survives later updates
n.get('claude:abc').pinned = true
apply(n, hook('Stop'))
assert.equal(n.get('claude:abc').pinned, true)

console.log('state.test.js ok')
