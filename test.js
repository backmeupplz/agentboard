// End-to-end check: boots a real server on a temp DB and walks the agent workflow.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', DATA_DIR: dir } })
const base = await new Promise((resolve, reject) => {
  srv.stdout.on('data', d => { const m = /(http:\/\/\S+)/.exec(d); if (m) resolve(m[1]) })
  srv.on('exit', reject)
})
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }) })

const req = async (method, p, { auth, body, type } = {}) => {
  const headers = {}
  if (auth?.startsWith('ab_session=')) headers.Cookie = auth
  else if (auth) headers.Authorization = 'Bearer ' + auth
  if (body !== undefined) headers['Content-Type'] = type || 'application/json'
  const r = await fetch(base + p, { method, headers, body: body === undefined || type ? body : JSON.stringify(body) })
  const text = await r.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: r.status, data, cookie: r.headers.get('set-cookie')?.split(';')[0] }
}

test('agent workflow', async () => {
  let r = await req('GET', '/api/board')
  assert.equal(r.status, 401); assert.equal(r.data.setup, true)

  r = await req('POST', '/api/setup', { body: { name: 'nikita', email: 'n@x.io', password: 'password1' } })
  assert.equal(r.status, 200); const human = r.cookie
  assert.equal((await req('POST', '/api/setup', { body: { name: 'b', email: 'b@x.io', password: 'password1' } })).status, 409)
  assert.equal((await req('POST', '/api/login', { body: { email: 'n@x.io', password: 'nope' } })).status, 401)
  assert.equal((await req('POST', '/api/login', { body: { email: 'N@x.io', password: 'password1' } })).status, 200)

  const { key } = (await req('POST', '/api/users', { auth: human, body: { kind: 'agent', name: 'astra' } })).data
  assert.match(key, /^ab_/)
  assert.equal((await req('POST', '/api/projects', { auth: key, body: { name: 'nope' } })).status, 403)
  assert.equal((await req('POST', '/api/projects', { auth: human, body: { name: 'Veydrift', repo: 'https://github.com/o/r' } })).status, 201)
  assert.equal((await req('POST', '/api/tickets', { auth: key, body: { title: 'x', project: 'ghost' } })).status, 400)

  // live stream sees what the agent does
  const ac = new AbortController()
  const stream = await fetch(base + '/api/stream', { headers: { Authorization: 'Bearer ' + key }, signal: ac.signal })
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader()
  const nextMessage = async () => { for (let buf = ''; ;) { buf += (await reader.read()).value; const m = /data: (.*)\n\n/.exec(buf); if (m) return JSON.parse(m[1]) } }

  r = await req('POST', '/api/tickets', { auth: key, body: { title: 'Fix login', project: 'veydrift', body: '# hi' } })
  assert.equal(r.status, 201); const id = r.data.id
  assert.deepEqual([r.data.column, r.data.project, r.data.created_by], ['to-do', 'Veydrift', 'astra'])
  assert.equal((await nextMessage()).events[0].type, 'created')

  r = await req('PATCH', `/api/tickets/${id}`, { auth: key, body: { if_column: 'To Do', column: 'in-progress', assignee: 'me', comment: 'mine' } })
  assert.deepEqual([r.data.column, r.data.assignee], ['in-progress', 'astra'])
  const m = await nextMessage()
  assert.deepEqual(m.events.map(e => e.type), ['moved', 'assigned', 'comment'])
  assert.equal(m.ticket.column, 'in-progress')
  assert.equal((await req('PATCH', `/api/tickets/${id}`, { auth: key, body: { if_column: 'to-do', column: 'done' } })).status, 409)
  ac.abort()

  r = await req('POST', '/api/files', { auth: key, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), type: 'image/png' })
  assert.equal(r.status, 201)
  assert.equal((await req('GET', r.data.url, { auth: key })).status, 200)
  assert.equal((await req('GET', r.data.url)).status, 401)
  assert.equal((await req('POST', '/api/files', { auth: key, body: '<svg/>', type: 'image/svg+xml' })).status, 415)

  assert.equal((await req('GET', '/api/tickets?column=in-progress&assignee=me', { auth: key })).data.length, 1)
  assert.equal((await req('GET', '/api/tickets?q=%23' + id, { auth: key })).data.length, 1)
  assert.equal((await req('GET', '/api/tickets?q=100%25', { auth: key })).data.length, 0)
  assert.equal((await req('GET', '/api/board?project=veydrift', { auth: key })).data.columns.find(c => c.slug === 'in-progress').count, 1)
  const evs = (await req('GET', '/api/events?after=1', { auth: key })).data
  assert.deepEqual(evs.map(e => e.type), ['moved', 'assigned', 'comment'])

  assert.equal((await req('DELETE', `/api/columns/in-progress`, { auth: human })).status, 409)
  assert.equal((await req('DELETE', `/api/tickets/${id}`, { auth: key })).status, 403)
  assert.equal((await req('DELETE', `/api/tickets/${id}`, { auth: human })).status, 200)
  assert.equal((await req('GET', `/api/tickets/${id}`, { auth: key })).status, 404)

  const out = execFileSync(process.execPath, ['bin/kb.mjs', 'new', 'From', 'CLI', '--project', 'veydrift'],
    { env: { ...process.env, AGENTBOARD_URL: base, AGENTBOARD_KEY: key }, input: 'piped body' })
  assert.equal(JSON.parse(out).body, 'piped body')
})
