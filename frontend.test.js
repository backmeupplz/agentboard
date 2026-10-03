import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import markdownit from 'markdown-it'

// Small DOM double: exercise the actual app functions without a browser dependency.
class Element {
  constructor() { this.children = []; this.dataset = {}; this.className = ''; this.events = {}; this.style = { setProperty() {} } }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn) }
  async dispatch(type, event = {}) { for (const fn of this.events[type] || []) await fn(event) }
  setAttribute(k, v) { if (k === 'data-id') this.dataset.id = String(v); else this[k] = v }
  append(...kids) { for (const k of kids) { this.children.push(k); if (k instanceof Element) k.parent = this } }
  replaceChildren(...kids) { this.children.forEach(k => { if (k instanceof Element) k.parent = null }); this.children = []; this.append(...kids) }
  insertBefore(el, before) { const i = this.children.indexOf(before); assert.notEqual(i, -1); this.children.splice(i, 0, el); el.parent = this }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null } }
  get textContent() { return this.children.map(k => k instanceof Element ? k.textContent : String(k)).join('') }
  set textContent(v) { this.replaceChildren(String(v)) }
  get classList() { return {
    contains: c => this.className.split(' ').includes(c),
    add: c => { if (!this.classList.contains(c)) this.className += ' ' + c },
    remove: c => { this.className = this.className.split(' ').filter(x => x !== c).join(' ') },
  } }
}
const source = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8')
function app() {
  const nodes = new Map(), window = new Element(), document = new Element(), streams = [], writes = [], requests = []
  document.querySelector = s => { if (!nodes.has(s)) nodes.set(s, new Element()); return nodes.get(s) }
  document.createElement = document.createElementNS = () => new Element()
  const location = { pathname: '/', search: '?project=Demo&assignee=other', hash: '', reloads: 0, reload() { this.reloads++ }, replace(url) { this.replaced = url } }
  let response = { status: 200, data: { id: 7, name: 'viewer' } }
  const context = vm.createContext({ document, window, location, markdownit, URLSearchParams, Blob,
    crypto: { randomUUID: () => 'changed' }, localStorage: { getItem: () => null, setItem: (k, v) => writes.push([k, v]) },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    IntersectionObserver: class { observe() {} unobserve() {} },
    EventSource: class { constructor() { streams.push(this) } },
    fetch: async (url, options) => { requests.push([url, options]); const r = response; return { ok: r.status === 200, status: r.status, headers: { get: () => 'application/json' }, json: async () => r.data } },
  })
  // Only replace browser-only import and automatic startup; all app logic is unchanged.
  vm.runInContext(source.replace(/^import markdownit[^\n]*\n/, '').replace(/\nstart\(\)\s*$/, '\n') + '\nglobalThis.app = { S, card, upsert, matches, refreshIdentity, connect, showAuth }', context)
  const api = context.app
  api.S.me = { id: 7, name: 'viewer' }; api.S.board = { projects: [], users: [] }
  api.S.f = { q: '', project: '', assignee: '' }
  return { ...api, document, window, location, streams, writes, requests, nodes, respond: (status, data) => { response = { status, data } } }
}
const ticket = { id: 42, title: 'Example', column: 'to-do', project: null, assignee: 'viewer', assignee_id: 7, position: 0, updated_at: '2026-10-03T00:00:00Z' }
const highlighted = el => el.classList.contains('assigned-to-me')

test('cards use stable numeric viewer identity, never names or selected filters', () => {
  const a = app()
  for (const assignee of ['', 'viewer', 'other', 'none']) {
    a.S.f = { q: 'unrelated', project: 'another', assignee }
    const mine = a.card({ ...ticket, assignee: 'renamed-viewer' })
    assert.equal(highlighted(mine), true)
    assert.match(mine.textContent, /Assigned to you/)
    for (const id of [8, null, undefined, '7']) {
      const other = a.card({ ...ticket, assignee_id: id })
      assert.equal(highlighted(other), false)
      assert.doesNotMatch(other.textContent, /Assigned to you/)
    }
  }
  a.S.me = null
  assert.equal(highlighted(a.card({ ...ticket, assignee: null, assignee_id: null })), false)
})

test('upsert replaces assignment styling and honors filters independently', () => {
  const a = app(), cards = new Element(), more = new Element()
  cards.append(more)
  const col = { cards, more, done: true, offset: 0 }
  a.S.cols.set('to-do', col)
  for (const id of [7, 8, null, 7]) {
    const previous = a.S.cards.get(42)?.el
    a.upsert({ ...ticket, assignee_id: id, assignee: id === 7 ? 'viewer' : id === 8 ? 'other' : null }, true)
    const el = a.S.cards.get(42).el
    assert.equal(highlighted(el), id === 7)
    assert.equal(el.textContent.includes('Assigned to you'), id === 7)
    assert.equal(col.offset, 1); assert.equal(cards.children.length, 2)
    if (previous) assert.equal(previous.parent, null)
  }
  a.S.f.assignee = 'other'
  a.upsert(ticket)
  assert.equal(a.S.cards.has(42), false); assert.equal(col.offset, 0)
  a.upsert({ ...ticket, assignee: 'other', assignee_id: 8 })
  assert.equal(highlighted(a.S.cards.get(42).el), false)
  a.S.f.assignee = 'none'
  a.upsert({ ...ticket, assignee: null, assignee_id: null })
  assert.equal(highlighted(a.S.cards.get(42).el), false)
})

test('session checks reload on identity change or expiry, not a rename or network error', async () => {
  const a = app()
  a.respond(200, { id: 7, name: 'renamed' }); await a.refreshIdentity()
  assert.equal(a.location.reloads, 0)
  a.respond(200, { id: 8, name: 'viewer' }); await a.window.dispatch('focus')
  assert.equal(a.location.reloads, 1)
  assert.equal(a.location.search, '?project=Demo&assignee=other')
  a.respond(401, { error: 'sign in' }); await a.refreshIdentity()
  assert.equal(a.location.reloads, 2)
  a.S.me = null; await a.refreshIdentity()
  assert.equal(a.location.reloads, 2)
  a.respond(200, { id: 7 }); await a.refreshIdentity()
  assert.equal(a.location.reloads, 3)
  a.respond(503, { error: 'offline' }); await assert.rejects(a.refreshIdentity(), /offline/)
  assert.equal(a.location.reloads, 3)
  await a.window.dispatch('storage', { key: 'activity' })
  assert.equal(a.location.reloads, 3)
  await a.window.dispatch('storage', { key: 'auth-change' })
  assert.equal(a.location.reloads, 4)
})

test('visibility and stream reconnection recheck identity; sign-in/out notify tabs', async () => {
  const a = app()
  a.document.hidden = true; await a.document.dispatch('visibilitychange')
  assert.equal(a.requests.length, 0)
  a.document.hidden = false; await a.document.dispatch('visibilitychange')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(a.requests[0][0], '/api/me')
  a.connect(); const stream = a.streams[0]
  stream.onopen(); assert.equal(a.requests.length, 1)
  stream.onerror(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(a.requests.at(-1)[0], '/api/me')
  a.respond(200, { id: 7, projects: [], users: [], columns: [] })
  stream.onopen(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(a.requests.filter(([url]) => url === '/api/me').length, 3)
  const form = a.document.querySelector('#auth')
  form.elements = { name: { value: 'viewer' }, email: { value: 'v@example.test' }, password: { value: 'password' } }
  form.querySelector = () => new Element()
  a.showAuth(false); await form.onsubmit({ preventDefault() {} })
  assert.equal(a.requests.at(-1)[0], '/api/login')
  assert.deepEqual(a.writes.at(-1), ['auth-change', 'changed'])
  assert.equal(a.location.replaced, '/')
  await a.nodes.get('#btn-logout').onclick()
  assert.equal(a.requests.at(-1)[0], '/api/logout')
  assert.equal(a.writes.length, 2); assert.equal(a.location.reloads, 1)
})
