#!/usr/bin/env node
// agentboard: one kanban board for AI agents and the humans watching them.
// Zero dependencies: node:http + node:sqlite + SSE.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(ROOT, 'public')
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'))
const FILES = path.join(DATA, 'files')
const SESSION_MS = 90 * 864e5
const MAX_UPLOAD = 25 << 20
// Only these are ever shown inline; every other upload is served as a download.
const INLINE_IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', ...INLINE_IMAGES }
fs.mkdirSync(FILES, { recursive: true })

const db = new DatabaseSync(path.join(DATA, 'board.db'))
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
  name TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE, pass TEXT, key_hash TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS columns(id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, position REAL NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL, repo TEXT);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  column_id INTEGER NOT NULL REFERENCES columns, project_id INTEGER REFERENCES projects ON DELETE SET NULL,
  assignee_id INTEGER REFERENCES users ON DELETE SET NULL, links TEXT NOT NULL DEFAULT '[]', position REAL NOT NULL,
  created_by INTEGER REFERENCES users ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tickets_column ON tickets(column_id, position);
CREATE INDEX IF NOT EXISTS tickets_updated ON tickets(updated_at);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets ON DELETE CASCADE,
  user_id INTEGER REFERENCES users ON DELETE SET NULL, type TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id, id);
CREATE TABLE IF NOT EXISTS files(name TEXT PRIMARY KEY, original TEXT NOT NULL, size INTEGER NOT NULL,
  user_id INTEGER REFERENCES users ON DELETE SET NULL, created_at INTEGER NOT NULL);
`)
const stmts = new Map()
const q = sql => stmts.get(sql) ?? stmts.set(sql, db.prepare(sql)).get(sql)
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } }
const slugify = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
if (!q('SELECT 1 FROM columns').get())
  ['To Do', 'In Progress', 'In Review', 'Done'].forEach((n, i) => q('INSERT INTO columns(name,slug,position) VALUES (?,?,?)').run(n, slugify(n), i))

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status } }
const need = (ok, status, msg) => { if (!ok) throw new HttpError(status, msg) }
const sha = s => createHash('sha256').update(s).digest('hex')
const hashPass = p => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(p, salt, 32).toString('hex') }
const DUMMY_HASH = hashPass(randomBytes(8).toString('hex'))
// Always runs scrypt, so response time doesn't reveal whether the email exists.
const checkPass = (p, stored) => { const [salt, h] = String(stored || DUMMY_HASH).split(':'); return timingSafeEqual(scryptSync(p, salt, 32), Buffer.from(h, 'hex')) && !!stored }
const newKey = () => 'ab_' + randomBytes(24).toString('base64url')
const iso = ms => ms == null ? null : new Date(ms).toISOString()
const text = (v, name, max, required) => {
  if (v == null || v === '') { need(!required, 400, `${name} is required`); return v === '' ? '' : undefined }
  need(typeof v === 'string' && v.length <= max, 400, `${name} must be a string of at most ${max} chars`)
  return v
}

// --- lookups: writes and filters speak names (column slug, project name, user name)
const columnId = v => { const r = q('SELECT id FROM columns WHERE slug=?').get(slugify(v)); need(r, 400, `unknown column "${v}" (GET /api/board lists them)`); return r.id }
const projectId = v => { if (!v) return null; const r = q('SELECT id FROM projects WHERE name=?').get(String(v)); need(r, 400, `unknown project "${v}"`); return r.id }
const getProject = name => { const r = q('SELECT * FROM projects WHERE name=?').get(name); need(r, 404, `project "${name}" not found`); return r }
const projectOut = ({ name, color, repo }) => ({ name, color, repo })
function projectFields(b, cur = { color: '#6e7cff', repo: null }) {
  const name = text(b.name === undefined ? cur.name : b.name, 'name', 64, true)
  need(name.trim(), 400, 'name must not be blank')
  const color = b.color === undefined ? cur.color : b.color
  need(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color), 400, 'color must be #rrggbb')
  const repo = b.repo === undefined ? cur.repo : b.repo
  need(repo === null || repo === '' || (typeof repo === 'string' && /^https?:\/\/\S+$/.test(repo) && repo.length < 2000), 400, 'repo must be an http(s) URL or null')
  if (repo) { let url; try { url = new URL(repo) } catch {} need(url?.hostname, 400, 'repo must be an http(s) URL or null') }
  return [name, color, repo || null]
}
const userId = (v, me) => { if (!v) return null; if (v === 'me') return me.id; const r = q('SELECT id FROM users WHERE name=?').get(String(v)); need(r, 400, `unknown user "${v}"`); return r.id }
const links = v => {
  if (v == null) return undefined
  const a = Array.isArray(v) ? v : [v]
  need(a.length <= 50 && a.every(l => typeof l === 'string' && /^https?:\/\/\S+$/.test(l) && l.length < 2000), 400, 'links must be http(s) URLs')
  return JSON.stringify(a)
}

const TICKET_SQL = full => `SELECT t.id, t.title, ${full ? 't.body,' : ''} c.slug AS "column", p.name AS project, a.name AS assignee, t.assignee_id,
  t.links, t.position, cb.name AS created_by, t.created_at, t.updated_at
  FROM tickets t JOIN columns c ON c.id=t.column_id LEFT JOIN projects p ON p.id=t.project_id
  LEFT JOIN users a ON a.id=t.assignee_id LEFT JOIN users cb ON cb.id=t.created_by`
const ticketOut = r => r && { ...r, links: JSON.parse(r.links), created_at: iso(r.created_at), updated_at: iso(r.updated_at) }
const getTicket = (id, full = true) => ticketOut(q(TICKET_SQL(full) + ' WHERE t.id=?').get(id))
const EVENT_SQL = `SELECT e.id, e.ticket_id, t.title AS ticket_title, u.name AS user, u.kind AS user_kind, e.type, e.body, e.created_at
  FROM events e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN tickets t ON t.id=e.ticket_id`
const eventOut = r => ({ ...r, created_at: iso(r.created_at) })
const addEvent = (ticketId, user, type, body = '') =>
  Number(q('INSERT INTO events(ticket_id,user_id,type,body,created_at) VALUES (?,?,?,?,?)').run(ticketId, user.id, type, body, Date.now()).lastInsertRowid)
const loadEvents = ids => ids.map(id => eventOut(q(EVENT_SQL + ' WHERE e.id=?').get(id)))

// --- realtime: every change is pushed to every open /api/stream
const streams = new Map() // res -> { userId, cred }
const emit = msg => { const s = `data: ${JSON.stringify(msg)}\n\n`; for (const res of streams.keys()) res.write(s) }
// Cut live streams whose credential was revoked (key rotated, user deleted, logged out).
const dropStreams = match => { for (const [res, who] of streams) if (match(who)) { streams.delete(res); res.end() } }
const emitTicket = (id, eventIds) => emit({ type: 'ticket', id, ticket: getTicket(id, false) ?? null, events: loadEvents(eventIds) })
setInterval(() => { for (const res of streams.keys()) res.write(': ping\n\n') }, 25e3).unref()

function filters(query, me) {
  const where = [], args = []
  if (query.project) query.project === 'none' ? where.push('t.project_id IS NULL') : (where.push('t.project_id=?'), args.push(projectId(query.project)))
  if (query.assignee) query.assignee === 'none' ? where.push('t.assignee_id IS NULL') : (where.push('t.assignee_id=?'), args.push(userId(query.assignee, me)))
  if (query.q) {
    const m = /^#?(\d+)$/.exec(query.q.trim())
    // ponytail: title LIKE scans every row (~ms at 50k); switch to FTS5 if bodies need searching
    m ? (where.push('t.id=?'), args.push(+m[1])) : (where.push("t.title LIKE ? ESCAPE '\\'"), args.push('%' + query.q.replace(/[\\%_]/g, '\\$&') + '%'))
  }
  return { where, args }
}

function listTickets(query, me) {
  const { where, args } = filters(query, me)
  if (query.column) where.push('t.column_id=?'), args.push(columnId(query.column))
  const limit = Math.min(Math.max(+query.limit || 50, 1), 500), offset = Math.max(+query.offset || 0, 0)
  const order = query.column ? 't.position, t.id' : 't.updated_at DESC'
  return q(`${TICKET_SQL(query.full === '1')} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, limit, offset).map(ticketOut)
}

function board(query, me) {
  const { where, args } = filters(query, me)
  const counts = Object.fromEntries(q(`SELECT column_id, count(*) n FROM tickets t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY column_id`)
    .all(...args).map(r => [r.column_id, r.n]))
  return {
    columns: q('SELECT id, name, slug FROM columns ORDER BY position').all().map(c => ({ slug: c.slug, name: c.name, count: counts[c.id] ?? 0 })),
    projects: q('SELECT name, color, repo FROM projects ORDER BY name').all(),
    users: q('SELECT name, kind FROM users ORDER BY kind DESC, name').all(),
  }
}

function createTicket(b, me) {
  const title = text(b.title, 'title', 500, true), body = text(b.body, 'body', 200000) ?? ''
  const col = b.column ? columnId(b.column) : q('SELECT id FROM columns ORDER BY position LIMIT 1').get().id
  const row = [title, body, col, projectId(b.project), userId(b.assignee, me), links(b.links) ?? '[]', -Date.now(), me.id, Date.now(), Date.now()]
  const [id, ev] = tx(() => {
    const id = Number(q(`INSERT INTO tickets(title,body,column_id,project_id,assignee_id,links,position,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...row).lastInsertRowid)
    return [id, addEvent(id, me, 'created')]
  })
  emitTicket(id, [ev])
  return getTicket(id)
}

function updateTicket(id, b, me) {
  const cur = q('SELECT * FROM tickets WHERE id=?').get(id)
  need(cur, 404, `ticket #${id} not found`)
  const curCol = q('SELECT slug, name FROM columns WHERE id=?').get(cur.column_id)
  if (b.if_column != null) need(slugify(b.if_column) === curCol.slug, 409, `ticket #${id} is in "${curCol.slug}", not "${b.if_column}"`)
  const set = {}, edited = [], events = []
  const title = text(b.title, 'title', 500, false), body = text(b.body, 'body', 200000), l = links(b.links)
  if (title && title !== cur.title) set.title = title, edited.push('title')
  if (body !== undefined && body !== cur.body) set.body = body, edited.push('description')
  if (l !== undefined && l !== cur.links) set.links = l, edited.push('links')
  if (b.project !== undefined && projectId(b.project) !== cur.project_id) set.project_id = projectId(b.project), edited.push('project')
  if (b.column !== undefined && columnId(b.column) !== cur.column_id) {
    set.column_id = columnId(b.column)
    events.push(['moved', `${curCol.name} → ${q('SELECT name FROM columns WHERE id=?').get(set.column_id).name}`])
    set.position = -Date.now() // moved tickets go to the top of their new column
  }
  if (b.position !== undefined) need(Number.isFinite(b.position), 400, 'position must be a number'), set.position = b.position
  if (b.assignee !== undefined && userId(b.assignee, me) !== cur.assignee_id) {
    set.assignee_id = userId(b.assignee, me)
    events.push(['assigned', set.assignee_id ? q('SELECT name FROM users WHERE id=?').get(set.assignee_id).name : ''])
  }
  if (edited.length) events.push(['edited', edited.join(', ')])
  const comment = text(b.comment, 'comment', 200000)
  if (comment) events.push(['comment', comment])
  if (!Object.keys(set).length && !events.length) return getTicket(id)
  if (events.length) set.updated_at = Date.now()
  const ids = tx(() => {
    if (Object.keys(set).length) q(`UPDATE tickets SET ${Object.keys(set).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(set), id)
    return events.map(([type, body]) => addEvent(id, me, type, body))
  })
  emitTicket(id, ids)
  return getTicket(id)
}

// --- users, auth
const userOut = (u, me) => ({ id: u.id, name: u.name, kind: u.kind, ...(me.kind === 'human' && { email: u.email }), has_key: !!u.key_hash, created_at: iso(u.created_at) })
const sessionToken = req => /(?:^|;\s*)ab_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]
function authUser(req) {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) {
    const u = q('SELECT * FROM users WHERE key_hash=?').get(sha(h.slice(7).trim()))
    return u && { ...u, cred: 'key' }
  }
  const tok = sessionToken(req)
  const u = tok && q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.created_at>?').get(sha(tok), Date.now() - SESSION_MS)
  return u && { ...u, cred: 'session:' + sha(tok) }
}
function login(req, res, user) {
  const tok = randomBytes(32).toString('base64url')
  q('DELETE FROM sessions WHERE created_at<?').run(Date.now() - SESSION_MS)
  q('INSERT INTO sessions VALUES (?,?,?)').run(sha(tok), user.id, Date.now())
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  res.setHeader('Set-Cookie', `ab_session=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`)
}
// ponytail: in-memory limiter, resets on restart; fine for one process
const failures = new Map()
const LOGIN_WINDOW = 15 * 60e3, LOGIN_MAX = 10
function loginAllowed(ip) {
  const f = failures.get(ip)
  if (f && Date.now() - f.since > LOGIN_WINDOW) failures.delete(ip)
  return (failures.get(ip)?.n ?? 0) < LOGIN_MAX
}
const loginFailed = ip => { const f = failures.get(ip) ?? { n: 0, since: Date.now() }; f.n++; failures.set(ip, f) }
// Containers can create the owner from env on first start; otherwise a fresh install needs the one-time
// token printed at startup, so nobody else can claim it first.
if (!q('SELECT 1 FROM users').get() && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const local = process.env.ADMIN_EMAIL.split('@')[0].replace(/[^\w.-]/g, '')
  const name = process.env.ADMIN_NAME || (local && !['me', 'none'].includes(local.toLowerCase()) ? local.slice(0, 64) : 'admin')
  createUser({ kind: 'human', name, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
  console.log(`created owner ${name} <${process.env.ADMIN_EMAIL}> from ADMIN_EMAIL/ADMIN_PASSWORD`)
}
let setupToken = q('SELECT 1 FROM users').get() ? null : randomBytes(16).toString('hex')
function createUser(b) {
  need(['human', 'agent'].includes(b.kind), 400, 'kind must be "human" or "agent"')
  const name = text(b.name, 'name', 64, true)
  need(/^[\w.-]+$/.test(name) && !['me', 'none'].includes(name.toLowerCase()), 400, 'name may contain letters, digits, _ . - only')
  if (b.kind === 'human') {
    need(typeof b.email === 'string' && b.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(b.email), 400, 'valid email required')
    need(typeof b.password === 'string' && b.password.length >= 8 && b.password.length <= 256, 400, 'password must be 8-256 chars')
    q('INSERT INTO users(kind,name,email,pass,created_at) VALUES (?,?,?,?,?)').run('human', name, b.email, hashPass(b.password), Date.now())
    return { user: q('SELECT * FROM users WHERE name=?').get(name) }
  }
  const key = newKey()
  q('INSERT INTO users(kind,name,key_hash,created_at) VALUES (?,?,?,?)').run('agent', name, sha(key), Date.now())
  return { user: q('SELECT * FROM users WHERE name=?').get(name), key }
}

// --- http plumbing
const readBody = (req, max) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0
  req.on('data', c => { size += c.length; if (size > max) { req.pause(); reject(new HttpError(413, `body over ${max} bytes`)) } else chunks.push(c) })
  req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject)
})
const json = async req => {
  const buf = await readBody(req, 1 << 20)
  if (!buf.length) return {}
  try { const v = JSON.parse(buf); need(v && typeof v === 'object' && !Array.isArray(v), 400, 'JSON body must be an object'); return v }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'invalid JSON body') }
}
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}
const created = (res, body) => { res.statusCode = 201; return body }
const human = me => need(me.kind === 'human', 403, 'humans only')
const ticketParam = s => { const n = +String(s).replace(/^#/, ''); need(Number.isInteger(n) && n > 0, 400, 'bad ticket id'); return n }

const routes = [
  ['GET', '/api', (req, res) => send(res, 200, fs.readFileSync(path.join(ROOT, 'API.md')), MIME['.md']), { public: true }],
  ['GET', '/api/health', () => ({ ok: true }), { public: true }],
  ['POST', '/api/setup', async (req, res) => {
    const b = await json(req)
    need(setupToken, 409, 'already set up')
    need(typeof b.token === 'string' && b.token.length === setupToken.length && timingSafeEqual(Buffer.from(b.token), Buffer.from(setupToken)),
      403, 'setup token required: open the setup link printed in the server log')
    const { user } = createUser({ ...b, kind: 'human' }); setupToken = null; login(req, res, user); return userOut(user, user)
  }, { public: true }],
  ['POST', '/api/login', async (req, res) => {
    const ip = req.socket.remoteAddress
    need(loginAllowed(ip), 429, 'too many failed sign-ins; try again in 15 minutes')
    const b = await json(req), u = q("SELECT * FROM users WHERE email=? AND kind='human'").get(String(b.email ?? '').slice(0, 254))
    const ok = checkPass(String(b.password ?? '').slice(0, 256), u?.pass)
    if (!ok) loginFailed(ip)
    need(ok, 401, 'wrong email or password'); failures.delete(ip); login(req, res, u); return userOut(u, u)
  }, { public: true }],
  ['POST', '/api/logout', (req, res, me) => {
    q('DELETE FROM sessions WHERE token_hash=?').run(sha(sessionToken(req) ?? ''))
    dropStreams(w => w.cred === me.cred)
    res.setHeader('Set-Cookie', 'ab_session=; Path=/; Max-Age=0'); return { ok: true }
  }],
  ['GET', '/api/me', (req, res, me) => userOut(me, me)],
  ['GET', '/api/board', (req, res, me, p, query) => board(query, me)],
  ['GET', '/api/tickets', (req, res, me, p, query) => listTickets(query, me)],
  ['POST', '/api/tickets', async (req, res, me) => created(res, createTicket(await json(req), me))],
  ['GET', '/api/tickets/:id', (req, res, me, p) => {
    const t = getTicket(ticketParam(p.id)); need(t, 404, `ticket #${p.id} not found`)
    return { ...t, events: q(EVENT_SQL + ' WHERE e.ticket_id=? ORDER BY e.id').all(t.id).map(eventOut) }
  }],
  ['PATCH', '/api/tickets/:id', async (req, res, me, p) => updateTicket(ticketParam(p.id), await json(req), me)],
  ['POST', '/api/tickets/:id/comments', async (req, res, me, p) => {
    const id = ticketParam(p.id), body = text((await json(req)).body, 'body', 200000, true)
    need(q('SELECT 1 FROM tickets WHERE id=?').get(id), 404, `ticket #${id} not found`)
    const ev = tx(() => { q('UPDATE tickets SET updated_at=? WHERE id=?').run(Date.now(), id); return addEvent(id, me, 'comment', body) })
    emitTicket(id, [ev]); return created(res, loadEvents([ev])[0])
  }],
  ['DELETE', '/api/tickets/:id', (req, res, me, p) => {
    human(me); const t = getTicket(ticketParam(p.id), false); need(t, 404, `ticket #${p.id} not found`)
    const ev = tx(() => { q('DELETE FROM tickets WHERE id=?').run(t.id); return addEvent(null, me, 'deleted', `#${t.id} ${t.title}`) })
    emitTicket(t.id, [ev]); return { ok: true }
  }],
  ['GET', '/api/events', (req, res, me, p, query) => {
    const limit = Math.min(Math.max(+query.limit || 100, 1), 1000), args = [], where = []
    if (query.ticket) where.push('e.ticket_id=?'), args.push(ticketParam(query.ticket))
    if (query.after) where.push('e.id>?'), args.push(+query.after || 0)
    const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const rows = query.after ? q(`${EVENT_SQL} ${w} ORDER BY e.id LIMIT ?`).all(...args, limit)
      : q(`${EVENT_SQL} ${w} ORDER BY e.id DESC LIMIT ?`).all(...args, limit).reverse()
    return rows.map(eventOut)
  }],
  ['GET', '/api/stream', (req, res, me) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
    res.write(': connected\n\n'); streams.set(res, { userId: me.id, cred: me.cred }); req.on('close', () => streams.delete(res))
  }],
  ['POST', '/api/files', async (req, res, me, p, query) => {
    // Keep a readable name, but only safe characters: it ends up in markdown and in Content-Disposition.
    const original = String(query.name || 'file').replace(/[^\w.\- ]+/g, '_').replace(/^[.\s]+/, '').slice(0, 120) || 'file'
    const ext = (/\.[a-z0-9]{1,10}$/i.exec(original)?.[0] ?? '').toLowerCase()
    const buf = await readBody(req, MAX_UPLOAD); need(buf.length, 400, 'empty upload')
    const name = randomBytes(16).toString('hex') + ext
    fs.writeFileSync(path.join(FILES, name), buf) // ponytail: files outlive deleted tickets; sweep unreferenced files if disk matters
    q('INSERT INTO files VALUES (?,?,?,?,?)').run(name, original, buf.length, me.id, Date.now())
    const url = '/files/' + name
    return created(res, { url, name: original, size: buf.length, image: ext in INLINE_IMAGES,
      markdown: ext in INLINE_IMAGES ? `![${original}](${url})` : `[${original}](${url})` })
  }],
  // --- columns (humans only)
  ['POST', '/api/columns', async (req, res, me) => {
    human(me); const name = text((await json(req)).name, 'name', 64, true); need(slugify(name), 400, 'name needs a letter or digit')
    q('INSERT INTO columns(name,slug,position) VALUES (?,?,(SELECT coalesce(max(position),0)+1 FROM columns))').run(name, slugify(name))
    emit({ type: 'meta' }); return created(res, { slug: slugify(name), name })
  }],
  ['PATCH', '/api/columns/:slug', async (req, res, me, p) => {
    human(me); const b = await json(req), id = columnId(p.slug)
    if (b.name !== undefined) { const name = text(b.name, 'name', 64, true); need(slugify(name), 400, 'name needs a letter or digit'); q('UPDATE columns SET name=?, slug=? WHERE id=?').run(name, slugify(name), id) }
    if (b.index !== undefined) {
      const ids = q('SELECT id FROM columns WHERE id<>? ORDER BY position').all(id).map(r => r.id)
      ids.splice(Math.max(0, Math.min(+b.index || 0, ids.length)), 0, id)
      tx(() => ids.forEach((cid, i) => q('UPDATE columns SET position=? WHERE id=?').run(i, cid)))
    }
    emit({ type: 'meta' }); return q('SELECT name, slug FROM columns WHERE id=?').get(id)
  }],
  ['DELETE', '/api/columns/:slug', (req, res, me, p) => {
    human(me); const id = columnId(p.slug), n = q('SELECT count(*) n FROM tickets WHERE column_id=?').get(id).n
    need(!n, 409, `column still has ${n} tickets; move them first`)
    need(q('SELECT count(*) n FROM columns').get().n > 1, 409, 'cannot delete the last column')
    q('DELETE FROM columns WHERE id=?').run(id); emit({ type: 'meta' }); return { ok: true }
  }],
  // --- projects (all authenticated users)
  ['GET', '/api/projects', () => q('SELECT name, color, repo FROM projects ORDER BY name').all()],
  ['GET', '/api/projects/:name', (req, res, me, p) => projectOut(getProject(p.name))],
  ['POST', '/api/projects', async (req, res) => {
    const row = projectFields(await json(req))
    q('INSERT INTO projects(name,color,repo) VALUES (?,?,?)').run(...row); emit({ type: 'meta' })
    return created(res, q('SELECT name, color, repo FROM projects WHERE name=?').get(row[0]))
  }],
  ['PATCH', '/api/projects/:name', async (req, res, me, p) => {
    const b = await json(req), cur = getProject(p.name), row = projectFields(b, cur)
    q('UPDATE projects SET name=?, color=?, repo=? WHERE id=?').run(...row, cur.id)
    emit({ type: 'meta' }); return q('SELECT name, color, repo FROM projects WHERE id=?').get(cur.id)
  }],
  ['DELETE', '/api/projects/:name', (req, res, me, p) => {
    q('DELETE FROM projects WHERE id=?').run(getProject(p.name).id); emit({ type: 'meta' }); return { ok: true }
  }],
  // --- people (writes are humans only)
  ['GET', '/api/users', (req, res, me) => q('SELECT * FROM users ORDER BY kind DESC, name').all().map(u => userOut(u, me))],
  ['POST', '/api/users', async (req, res, me) => {
    human(me); const { user, key } = createUser(await json(req)); emit({ type: 'meta' })
    return created(res, { ...userOut(user, me), ...(key && { key }) })
  }],
  ['POST', '/api/users/:name/key', (req, res, me, p) => {
    human(me); const key = newKey(), id = userId(p.name, me)
    q('UPDATE users SET key_hash=? WHERE id=?').run(sha(key), id); dropStreams(w => w.userId === id && w.cred === 'key'); return { key }
  }],
  ['DELETE', '/api/users/:name', (req, res, me, p) => {
    human(me); const id = userId(p.name, me); need(id !== me.id, 400, 'cannot delete yourself')
    q('DELETE FROM users WHERE id=?').run(id); dropStreams(w => w.userId === id); emit({ type: 'meta' }); return { ok: true }
  }],
].map(([method, pattern, fn, opts]) =>
  ({ method, fn, ...opts, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') }))

function serveFile(res, file, root, headers = {}) {
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' })
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...headers })
  fs.createReadStream(file).pipe(res)
}
function serveUpload(res, name) {
  const ext = path.extname(name).toLowerCase(), row = q('SELECT original FROM files WHERE name=?').get(name)
  const filename = encodeURIComponent(row?.original ?? name)
  // Uploads are untrusted: sandboxed, never sniffed, and anything but a plain raster image is a download.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  serveFile(res, path.join(FILES, name), FILES, ext in INLINE_IMAGES
    ? { 'Content-Type': INLINE_IMAGES[ext], 'Content-Disposition': `inline; filename*=UTF-8''${filename}`, 'Cache-Control': 'private, max-age=31536000, immutable' }
    : { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${filename}`, 'Cache-Control': 'private, no-cache' })
}
const VENDOR = { '/vendor/markdown-it.mjs': path.join(ROOT, 'node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs') }

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  const url = new URL(req.url, 'http://x'), query = Object.fromEntries(url.searchParams)
  try {
    // CSRF: browsers always send Origin on cross-origin writes. Other *.ts.net hosts count as "same-site", so SameSite alone isn't enough.
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      // X-Forwarded-Host comes from a reverse proxy (e.g. a Tailscale sidecar); a cross-site page can't set it without a CORS preflight.
      let host; try { host = new URL(req.headers.origin).host } catch {}
      need(host && [req.headers.host, req.headers['x-forwarded-host']].includes(host), 403, 'cross-origin request refused')
    }
    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { throw new HttpError(400, 'bad url') }
    if (pathname.startsWith('/api')) {
      // Match encoded segments first: a slash inside a name is data, not a route separator.
      const route = routes.find(r => r.method === req.method && r.re.test(url.pathname))
      need(route, 404, `no route ${req.method} ${pathname} (GET /api for docs)`)
      const me = authUser(req)
      if (!route.public && !me) return send(res, 401, { error: 'unauthorized: send "Authorization: Bearer <key>"', setup: !q('SELECT 1 FROM users').get() })
      const params = Object.fromEntries(Object.entries(route.re.exec(url.pathname).groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]))
      const out = await route.fn(req, res, me, params, query)
      if (out !== undefined) send(res, res.statusCode, out)
      return
    }
    if (pathname.startsWith('/files/')) {
      if (!authUser(req)) return send(res, 401, { error: 'unauthorized' })
      return serveUpload(res, path.basename(pathname))
    }
    if (VENDOR[pathname]) return serveFile(res, VENDOR[pathname], ROOT)
    return serveFile(res, path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname), PUBLIC)
  } catch (e) {
    // Unread upload left on the socket: answer, then hang up instead of draining it.
    if (!req.complete) { res.setHeader('Connection', 'close'); res.on('finish', () => req.destroy()) }
    if (e instanceof HttpError) return send(res, e.status, { error: e.message })
    if (/UNIQUE constraint/.test(e.message)) return send(res, 409, { error: 'already exists: ' + e.message.split(': ').pop() })
    console.error(e); send(res, 500, { error: 'internal error' })
  }
})
server.listen(+(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  const base = `http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`
  console.log(`agentboard on ${base}`)
  if (setupToken) console.log(`first run: create the owner account at ${base}/?setup=${setupToken}`)
})
export default server
