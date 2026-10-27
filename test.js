// End-to-end check: boots a real server on a temp DB and walks the agent workflow.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', DATA_DIR: dir } })
let log = ''
const [base, setupToken] = await new Promise((resolve, reject) => {
  srv.stdout.on('data', d => { log += d; const m = /on (http:\/\/\S+)[\s\S]*\?setup=(\w+)/.exec(log); if (m) resolve([m[1], m[2]]) })
  srv.on('exit', reject)
})
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }) })

const execFileAsync = promisify(execFile)
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
  const ownerId = r.data.id
  assert.ok(Number.isInteger(ownerId))
  assert.equal((await req('GET', '/api/me', { auth: human })).data.id, ownerId)
  assert.equal((await req('POST', '/api/setup', { body: { name: 'b', email: 'b@x.io', password: 'password1', token: setupToken } })).status, 409)
  assert.equal((await req('POST', '/api/login', { body: { email: 'n@x.io', password: 'nope' } })).status, 401)
  assert.equal((await req('POST', '/api/login', { body: { email: 'N@x.io', password: 'password1' } })).status, 200)

  ;({ key } = (await req('POST', '/api/users', { auth: human, body: { kind: 'agent', name: 'astra' } })).data)
  assert.match(key, /^ab_/)
  const agent = (await req('GET', '/api/me', { auth: key })).data
  assert.ok(Number.isInteger(agent.id)); assert.notEqual(agent.id, ownerId)
  assert.equal(agent.email, undefined)
  assert.equal((await req('GET', '/api/users', { auth: human })).data.find(u => u.name === 'astra').id, agent.id)
  assert.equal((await req('POST', '/api/projects', { auth: key, body: { name: 'Agent project' } })).status, 201)
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
  assert.equal(r.data.assignee_id, null)
  const created = await nextMessage()
  assert.equal(created.events[0].type, 'created'); assert.equal(created.ticket.assignee_id, null)

  r = await req('PATCH', `/api/tickets/${id}`, { auth: key, body: { if_column: 'To Do', column: 'in-progress', assignee: 'me', comment: 'mine' } })
  assert.deepEqual([r.data.column, r.data.assignee], ['in-progress', 'astra'])
  assert.equal(r.data.assignee_id, agent.id)
  const m = await nextMessage()
  assert.deepEqual(m.events.map(e => e.type), ['moved', 'assigned', 'comment'])
  assert.equal(m.ticket.column, 'in-progress')
  assert.equal(m.ticket.assignee_id, agent.id)
  assert.equal((await req('GET', `/api/tickets/${id}`, { auth: human })).data.assignee_id, agent.id)
  for (const query of ['', '?assignee=astra', '?full=1']) {
    assert.equal((await req('GET', '/api/tickets' + query, { auth: human })).data.find(t => t.id === id).assignee_id, agent.id)
  }
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

  // Assignment identity follows changes, including clearing/deleting the assignee.
  const assigned = (await req('POST', '/api/tickets', { auth: human, body: { title: 'Identity', assignee: 'me' } })).data
  assert.equal(assigned.assignee_id, ownerId)
  assert.equal((await req('PATCH', `/api/tickets/${assigned.id}`, { auth: human, body: { assignee: 'astra' } })).data.assignee_id, agent.id)
  assert.equal((await req('PATCH', `/api/tickets/${assigned.id}`, { auth: human, body: { assignee: null } })).data.assignee_id, null)
  const other = await req('POST', '/api/users', { auth: human, body: { kind: 'human', name: 'other', email: 'other@x.io', password: 'password2' } })
  const signedIn = await req('POST', '/api/login', { body: { email: 'other@x.io', password: 'password2' } })
  assert.equal(signedIn.data.id, other.data.id); assert.notEqual(signedIn.data.id, ownerId)
  assert.equal((await req('GET', '/api/me', { auth: signedIn.cookie })).data.id, other.data.id)
  assert.equal((await req('POST', '/api/logout', { auth: signedIn.cookie })).status, 200)
  assert.equal((await req('GET', '/api/me', { auth: signedIn.cookie })).status, 401)
  await req('PATCH', `/api/tickets/${assigned.id}`, { auth: human, body: { assignee: 'other' } })
  assert.equal((await req('DELETE', '/api/users/other', { auth: human })).status, 200)
  assert.equal((await req('GET', `/api/tickets/${assigned.id}`, { auth: human })).data.assignee_id, null)

  const out = execFileSync(process.execPath, ['bin/kb.mjs', 'new', 'From', 'CLI', '--project', 'veydrift'],
    { env: { ...process.env, AGENTBOARD_URL: base, AGENTBOARD_KEY: key }, input: 'piped body' })
  assert.equal(JSON.parse(out).body, 'piped body')
})

test('projects: agents and humans share CRUD without changing ticket data', async () => {
  const projectPath = name => '/api/projects/' + encodeURIComponent(name)
  const snapshot = async id => (await req('GET', '/api/tickets/' + id, { auth: key })).data
  for (const [auth, name] of [[key, 'abs+'], [human, 'Human Project']]) {
    const original = { name, color: '#aAbBcC', repo: 'https://github.com/o/r' }
    assert.deepEqual(await req('POST', '/api/projects', { auth, body: original }).then(r => [r.status, r.data]), [201, original])
    assert.deepEqual((await req('GET', projectPath(name.toUpperCase()), { auth })).data, original)
    assert.ok((await req('GET', '/api/projects', { auth })).data.some(p => p.name === name))
    const ticket = await req('POST', '/api/tickets', { auth, body: {
      title: 'Keep all ticket fields', body: 'Description', project: name, column: 'in-review', assignee: 'astra', links: ['https://example.com/pr/1'],
    } })
    assert.equal(ticket.status, 201)
    const before = await snapshot(ticket.data.id)
    const renamed = name + ' / café ?#%2F'
    const updated = { name: renamed, color: '#123456', repo: 'http://example.com/repo' }
    assert.deepEqual((await req('PATCH', projectPath(name), { auth, body: updated })).data, updated)
    assert.deepEqual((await req('GET', projectPath(renamed), { auth })).data, updated)
    assert.deepEqual(await snapshot(ticket.data.id), { ...before, project: renamed, projects: [renamed] })
    assert.equal((await req('GET', '/api/tickets?project=' + encodeURIComponent(renamed), { auth })).data[0].id, ticket.data.id)
    assert.equal((await req('GET', '/api/board?project=' + encodeURIComponent(renamed), { auth })).data.columns.find(c => c.slug === 'in-review').count, 1)
    assert.equal((await req('GET', projectPath(name), { auth })).status, 404)
    for (const repo of [null, '']) {
      assert.equal((await req('PATCH', projectPath(renamed), { auth, body: { repo } })).data.repo, null)
    }
    assert.deepEqual(await req('DELETE', projectPath(renamed), { auth }).then(r => [r.status, r.data]), [200, { ok: true }])
    assert.deepEqual(await snapshot(ticket.data.id), { ...before, project: null, projects: [] })
    assert.equal((await req('GET', projectPath(renamed), { auth })).status, 404)
  }
})

test('project validation is strict and atomic', async () => {
  const auth = key, p = '/api/projects/Validation'
  const original = { name: 'Validation', color: '#6e7cff', repo: null }
  assert.deepEqual((await req('POST', '/api/projects', { auth, body: { name: original.name } })).data, original)
  assert.equal((await req('POST', '/api/projects', { auth, body: { name: 'VALIDATION' } })).status, 409)
  assert.equal((await req('POST', '/api/projects', { auth, body: { name: 'Other project' } })).status, 201)
  assert.equal((await req('PATCH', p, { auth, body: { name: 'OTHER PROJECT', color: '#112233', repo: 'https://example.com' } })).status, 409)
  assert.deepEqual((await req('GET', p, { auth })).data, original)
  const invalid = [
    ...[null, '', '   ', '.', '..', 123, [], {}, 'x'.repeat(65)].map(name => ({ name })),
    ...[null, '', '#abc', 'red', 123, ['#123456'], {}].map(color => ({ color })),
    ...[false, 0, [], ['https://example.com'], {}, 'git@example.com:r', 'https://bad url', 'https://?', 'https://[', 'https://' + 'x'.repeat(2000)].map(repo => ({ repo })),
  ]
  for (const fields of invalid) {
    assert.equal((await req('POST', '/api/projects', { auth, body: { name: 'Invalid candidate', ...fields } })).status, 400, JSON.stringify(fields))
    assert.equal((await req('PATCH', p, { auth, body: { name: 'Changed', color: '#abcdef', repo: 'https://example.com/changed', ...fields } })).status, 400, JSON.stringify(fields))
    assert.deepEqual((await req('GET', p, { auth })).data, original)
    assert.equal((await req('GET', '/api/projects/Changed', { auth })).status, 404)
    assert.equal((await req('GET', '/api/projects/Invalid%20candidate', { auth })).status, 404)
  }
  assert.equal((await req('POST', '/api/projects', { auth, body: {} })).status, 400)
  assert.deepEqual((await req('PATCH', p, { auth, body: {} })).data, original)
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    assert.equal((await req(method, '/api/projects/missing', { auth, ...(method === 'PATCH' && { body: {} }) })).status, 404)
  }
  assert.equal((await req('GET', '/api/projects/bad%escape', { auth })).status, 400)
})

test('project auth does not grant administrative privileges', async () => {
  for (const auth of [undefined, 'ab_invalid']) {
    for (const [method, p, body] of [
      ['GET', '/api/projects'], ['GET', '/api/projects/Validation'],
      ['POST', '/api/projects', { name: 'Unauthorized' }],
      ['PATCH', '/api/projects/Validation', { color: '#112233' }], ['DELETE', '/api/projects/Validation'],
    ]) assert.equal((await req(method, p, { auth, body })).status, 401)
  }
  const adminWrites = [
    ['POST', '/api/columns', { name: 'Forbidden' }], ['PATCH', '/api/columns/to-do', { name: 'Forbidden' }], ['DELETE', '/api/columns/to-do'],
    ['POST', '/api/users', { kind: 'agent', name: 'forbidden' }], ['POST', '/api/users/astra/key'], ['DELETE', '/api/users/astra'],
    ['DELETE', '/api/tickets/1'],
  ]
  for (const [method, p, body] of adminWrites) {
    assert.equal((await req(method, p, { auth: key, body })).status, 403)
    assert.equal((await req(method, p, { body })).status, 401)
  }
  assert.equal((await req('POST', '/api/columns', { auth: human, body: { name: 'Human admin' } })).status, 201)
  assert.equal((await req('PATCH', '/api/columns/human-admin', { auth: human, body: { name: 'Human renamed' } })).status, 200)
  assert.equal((await req('DELETE', '/api/columns/human-renamed', { auth: human })).status, 200)
  for (const [method, p, body] of [
    ['POST', '/api/projects', { name: 'CSRF project' }],
    ['PATCH', '/api/projects/Validation', { name: 'CSRF renamed' }], ['DELETE', '/api/projects/Validation'],
  ]) assert.equal((await req(method, p, { auth: human, body, headers: { Origin: 'https://evil.example.com' } })).status, 403)
  assert.equal((await req('GET', '/api/projects/Validation', { auth: key })).data.name, 'Validation')
})

// ~70 CLI spawns: independent cases run concurrently, each case's steps stay in order.
test('project CLI is discoverable and encodes names', async () => {
  const run = (...args) => {
    const p = execFileAsync(process.execPath, ['bin/kb.mjs', ...args], { env: { ...process.env, AGENTBOARD_URL: base, AGENTBOARD_KEY: key } })
    p.child.stdin.end()
    return p.then(r => r.stdout, e => { e.status = e.code; throw e })
  }
  const cli = async (...args) => JSON.parse(await run('project', ...args))
  const fails = (args, check = () => true) => assert.rejects(cli(...args), e => e.status === 1 && check(e.stderr.toString()))
  await Promise.all([
    run('help').then(h => { assert.match(h, /project <ls\|show\|new\|set\|rename\|delete>/); assert.match(h, /all following arguments are positional/) }),
    run('project', 'help').then(h => { assert.match(h, /agents and humans/); assert.match(h, /All arguments after -- are positional/) }),
    run('project').then(h => assert.match(h, /human-only/)),
    ...['abs+', 'CLI space', 'CLI/org%2Frepo?#'].map(async name => {
      assert.deepEqual(await cli('new', name), { name, color: '#6e7cff', repo: null })
      assert.equal((await cli('show', name)).name, name)
      assert.ok((await cli('ls')).some(p => p.name === name))
      assert.equal((await cli('set', name, '--color', '#abcdef', '--repo', 'https://example.com/repo')).repo, 'https://example.com/repo')
      const renamed = name + ' renamed/slash'
      assert.equal((await cli('rename', name, renamed)).name, renamed)
      const finalName = renamed + ' final'
      assert.deepEqual(await cli('set', renamed, '--name', finalName, '--repo', 'none'), { name: finalName, color: '#abcdef', repo: null })
      assert.deepEqual(await cli('delete', finalName), { ok: true })
      await fails(['show', finalName], err => /404/.test(err))
    }),
    ...['--odd', '--', '--__proto__'].map(async name => {
      const original = { name, color: '#123456', repo: 'https://example.com/repo' }
      assert.deepEqual(await cli('new', '--color', original.color, '--repo', original.repo, '--', name), original)
      assert.deepEqual(await cli('show', '--', name), original)
      assert.deepEqual(await cli('set', '--color', '#abcdef', '--repo', 'none', '--', name), { name, color: '#abcdef', repo: null })
      const renamed = name + '-renamed'
      assert.equal((await cli('rename', '--', name, renamed)).name, renamed)
      const finalName = name + '-final'
      assert.equal((await cli('set', '--name', finalName, '--', renamed)).name, finalName)
      assert.deepEqual(await cli('delete', '--', finalName), { ok: true })
      await fails(['show', '--', finalName], err => /404/.test(err))
    }),
    // The shared parser treats everything after the sentinel as positional, not options.
    run('new', '--body', 'Sentinel body', '--', '--odd', '--color', 'red', '--').then(out => {
      const ticket = JSON.parse(out)
      assert.equal(ticket.title, '--odd --color red --')
      assert.equal(ticket.body, 'Sentinel body')
    }),
    ...[['new'], ['delete'], ['rename', 'x'], ['unknown'], ['ls', 'extra'], ['set', 'Validation', '--colr', '#123456'], ['set', '--', 'Validation', '--color', '#123456']].map(args => fails(args)),
    ...['--__proto__', '--constructor', '--toString'].map(option => fails(['set', 'Validation', option, 'ignored'], err => err.includes(`unknown option ${option}`))),
    fails(['new', 'Invalid CLI', '--color', 'red'], err => /400/.test(err)),
    fails(['new', 'VALIDATION'], err => /409/.test(err)),
  ])
  assert.deepEqual(await cli('show', 'Validation'), { name: 'Validation', color: '#6e7cff', repo: null })
})

test('project writes emit metadata events', async () => {
  const ac = new AbortController()
  try {
    const stream = await fetch(base + '/api/stream', { headers: { Authorization: 'Bearer ' + key }, signal: ac.signal })
    const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader()
    const nextMessage = async () => { for (let buf = ''; ;) { buf += (await reader.read()).value; const m = /data: (.*)\n\n/.exec(buf); if (m) return JSON.parse(m[1]) } }
    for (const [method, p, body] of [
      ['POST', '/api/projects', { name: 'Stream project' }],
      ['PATCH', '/api/projects/Stream%20project', { name: 'Stream/renamed' }],
      ['DELETE', '/api/projects/Stream%2Frenamed'],
    ]) {
      assert.ok((await req(method, p, { auth: key, body })).status < 300)
      assert.deepEqual(await nextMessage(), { type: 'meta' })
    }
  } finally { ac.abort() }
})

test('a ticket can carry several projects', async () => {
  const auth = key, names = ['Multi A', 'Multi B', 'Multi C']
  for (const name of names) assert.equal((await req('POST', '/api/projects', { auth, body: { name } })).status, 201)
  const list = async (query) => (await req('GET', '/api/tickets?' + query, { auth })).data.map(t => t.id)
  let t = (await req('POST', '/api/tickets', { auth, body: { title: 'Two projects', projects: ['multi b', 'Multi A', 'MULTI B'], column: 'in-review' } })).data
  assert.deepEqual([t.project, t.projects], ['Multi B', ['Multi B', 'Multi A']]) // names resolve case-insensitively, duplicates drop, order stays
  assert.ok((await list('project=Multi%20A')).includes(t.id)); assert.ok((await list('project=Multi%20B')).includes(t.id))
  assert.ok(!(await list('project=Multi%20C')).includes(t.id)); assert.ok(!(await list('project=none&limit=500')).includes(t.id))
  assert.equal((await req('GET', '/api/board?project=Multi%20A', { auth })).data.columns.find(c => c.slug === 'in-review').count, 1)
  const patch = async body => (await req('PATCH', '/api/tickets/' + t.id, { auth, body })).data
  assert.deepEqual((await patch({ projects: ['Multi C', 'Multi A'] })).projects, ['Multi C', 'Multi A'])
  assert.deepEqual((await patch({ project: 'Multi B' })).projects, ['Multi B']) // the single field replaces the whole list
  assert.deepEqual((await patch({ projects: ['Multi A', 'Multi B'] })).projects, ['Multi A', 'Multi B'])
  const events = (await req('GET', '/api/tickets/' + t.id, { auth })).data.events
  assert.deepEqual(events.filter(e => e.type === 'edited').map(e => e.body), ['project', 'project', 'project'])
  assert.equal((await req('PATCH', '/api/tickets/' + t.id, { auth, body: { projects: ['Multi A', 'ghost'] } })).status, 400)
  assert.equal((await req('PATCH', '/api/tickets/' + t.id, { auth, body: { projects: 'Multi A' } })).status, 400)
  assert.deepEqual((await req('GET', '/api/tickets/' + t.id, { auth })).data.projects, ['Multi A', 'Multi B']) // a refused write changes nothing
  // Deleting a project drops only that one; the next becomes the main project.
  assert.equal((await req('DELETE', '/api/projects/Multi%20A', { auth })).status, 200)
  t = (await req('GET', '/api/tickets/' + t.id, { auth })).data
  assert.deepEqual([t.project, t.projects], ['Multi B', ['Multi B']])
  assert.deepEqual((await patch({ projects: null })).projects, [])
  assert.ok((await list('project=none&limit=500')).includes(t.id))
  // CLI: a comma-separated --project sets several; none clears them.
  const kb = (...args) => JSON.parse(execFileSync(process.execPath, ['bin/kb.mjs', ...args], { env: { ...process.env, AGENTBOARD_URL: base, AGENTBOARD_KEY: key }, input: '' }))
  const made = kb('new', 'CLI', 'projects', '--project', 'Multi C, Multi B')
  assert.deepEqual(made.projects, ['Multi C', 'Multi B'])
  assert.deepEqual(kb('set', String(made.id), '--project', 'Multi B').projects, ['Multi B'])
  assert.deepEqual(kb('set', String(made.id), '--project', 'none').projects, [])
})

test('migration: an existing board keeps every ticket\'s project', async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-old-'))
  try {
    // The schema before ticket_projects existed, with one ticket in a project and one without.
    const db = new DatabaseSync(path.join(old, 'board.db'))
    db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE, pass TEXT, key_hash TEXT UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE columns(id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, position REAL NOT NULL);
      CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL, repo TEXT);
      CREATE TABLE tickets(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', column_id INTEGER NOT NULL REFERENCES columns,
        project_id INTEGER REFERENCES projects ON DELETE SET NULL, assignee_id INTEGER REFERENCES users ON DELETE SET NULL, links TEXT NOT NULL DEFAULT '[]',
        position REAL NOT NULL, created_by INTEGER REFERENCES users ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO columns VALUES (1, 'To Do', 'to-do', 0); INSERT INTO projects VALUES (1, 'veydrift', '#6e7cff', NULL);
      INSERT INTO tickets(id, title, column_id, project_id, position, created_at, updated_at) VALUES (5, 'old', 1, 1, 0, 1, 1), (6, 'loose', 1, NULL, 0, 1, 1);`)
    db.close()
    for (let run = 0; run < 2; run++) { // a second start must not change anything
      const s = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', DATA_DIR: old } })
      await new Promise((resolve, reject) => { s.stdout.on('data', d => /agentboard on/.test(d) && resolve()); s.on('exit', reject) })
      s.kill(); await new Promise(r => s.on('exit', r))
    }
    const after = new DatabaseSync(path.join(old, 'board.db'))
    assert.deepEqual(after.prepare('SELECT ticket_id, project_id, pos FROM ticket_projects').all().map(r => ({ ...r })), [{ ticket_id: 5, project_id: 1, pos: 0 }])
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 1)
    after.close()
  } finally { fs.rmSync(old, { recursive: true, force: true }) }
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
