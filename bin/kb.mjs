#!/usr/bin/env node
// kb: tiny agentboard CLI. Env: AGENTBOARD_URL (default http://127.0.0.1:3000), AGENTBOARD_KEY.
import fs from 'node:fs'
import path from 'node:path'

const HELP = `kb <command>            (env: AGENTBOARD_URL, AGENTBOARD_KEY; full API: kb docs)
  board                                   columns (with counts), projects, users
  ls [--column c] [--project p] [--assignee a|me|none] [--q text] [--limit n] [--offset n]
  show <id>                               ticket + timeline
  new <title> [--column c] [--project p] [--assignee a] [--link url]... [--body md]   body from stdin if piped
  set <id> [--title t] [--column c] [--project p] [--assignee a|none] [--link url]... [--body md] [--comment md] [--if-column c]
  mv <id> <column> [comment]              move (and optionally comment)
  comment <id> [markdown]                 markdown from stdin if omitted
  attach <id> <file>... [--comment md]    upload files (images show inline) and post them as one comment
  events [--after id] [--ticket id]       event log, oldest first
  watch                                   stream live changes (one JSON per line)
  api <METHOD> <path> [json]              raw call, e.g. kb api GET /api/tickets/42
  docs                                    print the API docs`

const URL_ = (process.env.AGENTBOARD_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const KEY = process.env.AGENTBOARD_KEY
const [cmd, ...rest] = process.argv.slice(2)
const pos = [], opt = {}
for (let i = 0; i < rest.length; i++) {
  const m = /^--([\w-]+)$/.exec(rest[i])
  if (!m) { pos.push(rest[i]); continue }
  const k = m[1].replace(/-/g, '_'), v = rest[++i]
  if (v === undefined) die(`--${m[1]} needs a value`)
  k === 'link' ? (opt.links ??= []).push(v) : (opt[k] = v)
}
function die(msg) { console.error(msg); process.exit(1) }
const stdin = () => process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8')
const none = v => v === 'none' ? null : v

async function call(method, p, body, type = 'application/json') {
  const res = await fetch(URL_ + p, { method, body: type === 'application/json' && body ? JSON.stringify(body) : body,
    headers: { ...(KEY && { Authorization: 'Bearer ' + KEY }), ...(body && { 'Content-Type': type }) } })
  const out = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text()
  if (!res.ok) die(`${res.status}: ${out.error || out}`)
  return out
}
const print = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
const qs = o => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)); return p.size ? '?' + p : '' }

const commands = {
  board: () => call('GET', '/api/board'),
  ls: () => call('GET', '/api/tickets' + qs(opt)),
  show: () => call('GET', '/api/tickets/' + pos[0]),
  new: () => call('POST', '/api/tickets', { title: pos.join(' '), body: opt.body ?? stdin(), column: opt.column, project: opt.project, assignee: opt.assignee, links: opt.links }),
  set: () => call('PATCH', '/api/tickets/' + pos[0], { ...opt, ...('assignee' in opt && { assignee: none(opt.assignee) }), ...('project' in opt && { project: none(opt.project) }) }),
  mv: () => call('PATCH', '/api/tickets/' + pos[0], { column: pos[1], comment: pos.slice(2).join(' ') || undefined }),
  comment: () => call('POST', `/api/tickets/${pos[0]}/comments`, { body: pos.slice(1).join(' ') || stdin() }),
  attach: async () => {
    const [id, ...files] = pos
    if (!files.length) die('usage: kb attach <id> <file>... [--comment md]')
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
    const uploaded = []
    for (const f of files) uploaded.push(await call('POST', '/api/files?name=' + encodeURIComponent(path.basename(f)), fs.readFileSync(f),
      types[path.extname(f).toLowerCase()] || 'application/octet-stream'))
    return call('POST', `/api/tickets/${id}/comments`, { body: [opt.comment, uploaded.map(u => u.markdown).join(' ')].filter(Boolean).join('\n\n') })
  },
  events: () => call('GET', '/api/events' + qs(opt)),
  watch: async () => {
    const res = await fetch(URL_ + '/api/stream', { headers: { Authorization: 'Bearer ' + KEY } })
    if (!res.ok) die(`${res.status}: ${await res.text()}`)
    let buf = ''
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (line.startsWith('data: ')) console.log(line.slice(6)) }
    }
  },
  api: () => call(pos[0], pos[1], pos[2] && JSON.parse(pos[2])),
  docs: () => call('GET', '/api'),
}
if (!commands[cmd]) { console.log(HELP); process.exit(cmd && cmd !== 'help' ? 1 : 0) }
const out = await commands[cmd]()
if (out !== undefined) print(out)
