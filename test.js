// End-to-end check: boots a real server on a temp DB and walks the agent workflow.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', DATA_DIR: dir } })
let log = ''
const [base, setupToken] = await new Promise((resolve, reject) => {
  srv.stdout.on('data', d => { log += d; const m = /on (http:\/\/\S+)[\s\S]*\?setup=(\w+)/.exec(log); if (m) resolve([m[1], m[2]]) })
  srv.on('exit', reject)
})
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }) })

const req = async (method, p, { auth, body, type, headers = {} } = {}) => {
  if (auth?.startsWith('ab_session=')) headers.Cookie = auth
  else if (auth) headers.Authorization = 'Bearer ' + auth
  if (body !== undefined) headers['Content-Type'] = type || 'application/json'
  const r = await fetch(base + p, { method, headers, body: body === undefined || type ? body : JSON.stringify(body) })
  const text = await r.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: r.status, data, cookie: r.headers.get('set-cookie')?.split(';')[0], headers: r.headers }
}

let human, key
test('agent workflow', async () => {
  let r = await req('GET', '/api/board')
  assert.equal(r.status, 401); assert.equal(r.data.setup, true)

  assert.equal((await req('POST', '/api/setup', { body: { name: 'nikita', email: 'n@x.io', password: 'password1' } })).status, 403)
  assert.equal((await req('POST', '/api/setup', { body: { name: 'nikita', email: 'n@x.io', password: 'password1', token: 'x'.repeat(32) } })).status, 403)
  r = await req('POST', '/api/setup', { body: { name: 'nikita', email: 'n@x.io', password: 'password1', token: setupToken } })
  assert.equal(r.status, 200); human = r.cookie
  assert.equal((await req('POST', '/api/setup', { body: { name: 'b', email: 'b@x.io', password: 'password1', token: setupToken } })).status, 409)
  assert.equal((await req('POST', '/api/login', { body: { email: 'n@x.io', password: 'nope' } })).status, 401)
  assert.equal((await req('POST', '/api/login', { body: { email: 'N@x.io', password: 'password1' } })).status, 200)

  ;({ key } = (await req('POST', '/api/users', { auth: human, body: { kind: 'agent', name: 'astra' } })).data)
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

  r = await req('POST', '/api/files?name=shot.png', { auth: key, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), type: 'image/png' })
  assert.equal(r.status, 201); assert.equal(r.data.markdown, `![shot.png](${r.data.url})`)
  const img = await req('GET', r.data.url, { auth: key })
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png')
  assert.equal((await req('GET', r.data.url)).status, 401)

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

test('security', async () => {
  // Uploaded HTML/SVG never renders on our origin: forced download, sandboxed, and a sanitized name.
  for (const [name, type] of [['x.svg', 'image/svg+xml'], ['a"b\r\nSet-Cookie: x.html', 'text/html']]) {
    const up = await req('POST', '/api/files?name=' + encodeURIComponent(name), { auth: key, body: '<script>alert(1)</script>', type })
    assert.equal(up.status, 201); assert.match(up.data.name, /^[\w.\- ]+$/); assert.equal(up.data.image, false)
    const f = await req('GET', up.data.url, { auth: key })
    assert.equal(f.headers.get('content-type'), 'application/octet-stream')
    assert.match(f.headers.get('content-disposition'), /^attachment;/)
    assert.match(f.headers.get('content-security-policy'), /sandbox/)
  }
  // CSRF: cookie-authenticated writes from another origin are refused; same-origin ones pass.
  const evil = { Origin: 'http://evil.icefish-betta.ts.net' }
  assert.equal((await req('POST', '/api/tickets', { auth: human, body: { title: 'csrf' }, headers: evil })).status, 403)
  assert.equal((await req('POST', '/api/tickets', { auth: human, body: { title: 'ok' }, headers: { Origin: base } })).status, 201)
  const proxied = { Origin: 'https://agentboard.icefish-betta.ts.net', 'X-Forwarded-Host': 'agentboard.icefish-betta.ts.net' }
  assert.equal((await req('POST', '/api/tickets', { auth: human, body: { title: 'via proxy' }, headers: proxied })).status, 201)
  assert.deepEqual((await req('GET', '/api/health')).data, { ok: true })
  // Strict CSP on the app shell.
  const csp = (await req('GET', '/')).headers.get('content-security-policy')
  assert.doesNotMatch(csp, /unsafe-inline|https:/)
  // Rotating a key cuts that key's live stream.
  const stream = await fetch(base + '/api/stream', { headers: { Authorization: 'Bearer ' + key } })
  const reader = stream.body.getReader(); await reader.read()
  assert.equal((await req('POST', '/api/users/astra/key', { auth: human })).status, 200)
  for (let r; !(r = await reader.read()).done;);
  assert.equal((await req('GET', '/api/board', { auth: key })).status, 401)
  // Brute force: 10 wrong passwords, then even the right one is refused for a while.
  for (let i = 0; i < 10; i++) assert.equal((await req('POST', '/api/login', { body: { email: 'n@x.io', password: 'wrong' + i } })).status, 401)
  assert.equal((await req('POST', '/api/login', { body: { email: 'n@x.io', password: 'password1' } })).status, 429)
})
