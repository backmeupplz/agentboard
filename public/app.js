import markdownit from '/vendor/markdown-it.mjs'

// html:false escapes raw HTML; markdown-it's validateLink blocks javascript:/data: URLs.
const md = markdownit({ html: false, linkify: true, breaks: true })
const defaultLink = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o))
md.renderer.rules.link_open = (tokens, i, o, e, self) => {
  if (!tokens[i].attrGet('href').startsWith('/files/')) tokens[i].attrSet('target', '_blank'), tokens[i].attrSet('rel', 'noopener noreferrer')
  return defaultLink(tokens, i, o, e, self)
}

// ---------- tiny DOM kit
const $ = s => document.querySelector(s)
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'style') Object.entries(v).forEach(([p, x]) => el.style.setProperty(p, x)) // CSSOM, allowed by the strict CSP
    else if (k === 'value') continue
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v)
  }
  el.append(...kids.flat().filter(k => k != null && k !== false))
  if ('value' in attrs) el.value = attrs.value ?? ''
  return el
}
const icon = name => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  svg.setAttribute('class', 'i'); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', '/icons.svg#' + name); svg.append(use)
  return svg
}
const btn = (iconName, label, onclick, cls = 'ghost icon') =>
  h('button', { type: 'button', class: 'btn ' + cls, title: label, 'aria-label': label, onclick }, icon(iconName))
const options = (list, value) => list.map(([v, label]) => h('option', { value: v, selected: v === (value ?? '') }, label))
const qs = o => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)); return p.size ? '?' + p : '' }
const ago = t => { const s = (Date.now() - new Date(t)) / 1e3; return s < 60 ? 'now' : s < 3600 ? `${s / 60 | 0}m` : s < 86400 ? `${s / 3600 | 0}h` : `${s / 86400 | 0}d` }
const time = t => h('time', { 'data-time': t, datetime: t, title: new Date(t).toLocaleString() }, ago(t))
const store = { get: k => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }
const shortLink = u => {
  const m = /^https?:\/\/github\.com\/([^/]+\/[^/#?]+)(?:\/(?:pull|issues)\/(\d+))?/.exec(u)
  return m ? m[1] + (m[2] ? ' #' + m[2] : '') : u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70)
}
const linkIcon = u => /\/pull\/\d+/.test(u) ? 'git-pull-request' : /github\.com\/[^/]+\/[^/]+\/?$/.test(u) ? 'folder-git-2' : 'link'

function toast(msg, bad = true) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg)
  $('#toasts').append(el); setTimeout(() => el.remove(), 4000)
}
const attempt = fn => async (...a) => { try { return await fn(...a) } catch (e) { toast(e.message) } }

async function api(method, url, body) {
  const raw = body instanceof Blob
  const r = await fetch('/api' + url, { method, body: raw ? body : body && JSON.stringify(body),
    headers: raw ? { 'Content-Type': body.type || 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {} })
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text()
  if (!r.ok) {
    if (r.status === 401 && S.me) location.reload()
    throw Object.assign(new Error(data.error || r.statusText), { status: r.status, data })
  }
  return data
}

const S = { me: null, board: null, cols: new Map(), cards: new Map(), gen: 0, tab: 'columns', newKind: 'agent',
  f: Object.fromEntries(['q', 'project', 'assignee'].map(k => [k, new URLSearchParams(location.search).get(k) || ''])) }

// ---------- people & projects
const userKind = name => S.board?.users.find(u => u.name === name)?.kind
const project = name => S.board.projects.find(p => p.name === name)
const hue = name => [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)
const avatar = (name, kind = userKind(name)) => kind === 'agent'
  ? h('span', { class: 'avatar agent', title: name + ' (agent)' }, icon('bot'))
  : h('span', { class: 'avatar', style: { '--h': `hsl(${hue(name)} 45% 38%)` }, title: name }, name[0].toUpperCase())
const who = name => name ? h('span', { class: 'who' }, avatar(name), name) : h('span', { class: 'who faint' }, 'someone')
const flair = name => { const p = project(name); return p && h('span', { class: 'flair', style: { '--c': p.color } }, p.name) }

// ---------- auth
// Cookies are shared across tabs. Recheck on return/reconnect and notify other tabs
// after sign-in/out; reload only when identity changes, preserving the URL filters.
const authChanged = () => store.set('auth-change', `${Date.now()}-${Math.random()}`)
async function refreshIdentity() {
  try {
    const me = await api('GET', '/me')
    if (me.id !== S.me?.id) location.reload()
  } catch (e) {
    if (e.status !== 401) throw e
  }
}
window.addEventListener('storage', e => { if (e.key === 'auth-change') location.reload() })
window.addEventListener('focus', attempt(refreshIdentity))
document.addEventListener('visibilitychange', () => { if (!document.hidden) attempt(refreshIdentity)() })

async function start() {
  try { S.me = await api('GET', '/me') } catch (e) { return showAuth(e.data?.setup) }
  $('#app').hidden = false
  $('#btn-logout').title = `Sign out ${S.me.name}`
  $('#f-q').value = S.f.q
  connect()
  await loadBoard()
  if (store.get('activity') === '1') attempt(toggleActivity)()
  route()
}
function showAuth(setup) {
  const f = $('#auth'), el = f.elements, token = new URLSearchParams(location.search).get('setup')
  f.hidden = false
  el.name.hidden = !setup; el.name.required = !!setup
  f.querySelector('button').textContent = setup ? 'Create owner account' : 'Sign in'
  $('#auth-hint').textContent = setup ? (token ? 'First run: create the owner account.' : 'First run: open the setup link printed in the server log.') : ''
  f.onsubmit = async e => {
    e.preventDefault()
    try {
      await api('POST', setup ? '/setup' : '/login', { name: el.name.value, email: el.email.value, password: el.password.value, token })
      authChanged()
      location.replace(location.pathname)
    } catch (err) { $('#auth-error').textContent = err.message }
  }
}

// ---------- board
const matches = t => {
  const { q, project, assignee } = S.f, eq = (a, b) => (a || '').toLowerCase() === b.toLowerCase()
  const id = /^#?(\d+)$/.exec(q.trim())
  return (!project || (project === 'none' ? !t.project : eq(t.project, project)))
    && (!assignee || (assignee === 'none' ? !t.assignee : eq(t.assignee, assignee)))
    && (!q || (id ? t.id === +id[1] : t.title.toLowerCase().includes(q.toLowerCase())))
}
const byPos = (a, b) => a.position - b.position || a.id - b.id
const observer = new IntersectionObserver(entries => entries.forEach(e => e.isIntersecting && loadMore(e.target.col)))

async function loadBoard() {
  const gen = ++S.gen
  const board = await api('GET', '/board' + qs(S.f))
  if (gen !== S.gen) return
  S.board = board
  renderFilters()
  S.cols.forEach(c => observer.unobserve(c.more)); S.cols.clear(); S.cards.clear()
  $('#board').replaceChildren(...board.columns.map(c => {
    const col = { slug: c.slug, offset: 0, done: false, loading: false, gen }
    col.count = h('span', { class: 'count' }, c.count)
    col.more = h('div', { class: 'more' }); col.more.col = col
    col.cards = h('div', { class: 'cards',
      ondragover: e => { if (e.dataTransfer.types.includes('text/plain')) { e.preventDefault(); col.cards.classList.add('drop') } },
      ondragleave: e => { if (!col.cards.contains(e.relatedTarget)) col.cards.classList.remove('drop') },
      ondrop: e => drop(e, col) }, col.more)
    S.cols.set(c.slug, col)
    return h('section', { class: 'col' }, h('div', { class: 'col-head' }, c.name, col.count), col.cards)
  }))
  S.cols.forEach(c => observer.observe(c.more))
}

async function loadMore(col) {
  if (col.loading || col.done || col.gen !== S.gen) return
  col.loading = true
  try {
    const list = await api('GET', '/tickets' + qs({ ...S.f, column: col.slug, offset: col.offset, limit: 60 }))
    if (col.gen !== S.gen) return
    col.offset += list.length; col.done = list.length < 60
    for (const t of list) if (!S.cards.has(t.id)) col.cards.insertBefore(card(t), col.more)
  } finally { col.loading = false }
  if (!col.done) { observer.unobserve(col.more); observer.observe(col.more) } // re-check: sentinel may still be visible
}

function card(t) {
  const mine = S.me?.id != null && t.assignee_id === S.me.id
  const el = h('article', { class: 'card' + (mine ? ' assigned-to-me' : ''), draggable: 'true', 'data-id': t.id, tabindex: 0,
    onclick: () => { location.hash = t.id }, onkeydown: e => { if (e.key === 'Enter') location.hash = t.id },
    ondragstart: e => { e.dataTransfer.setData('text/plain', t.id); el.classList.add('dragging') },
    ondragend: () => el.classList.remove('dragging') },
    h('div', { class: 'meta' }, h('span', { class: 'id' }, '#' + t.id), flair(t.project), h('span', { class: 'grow' }), time(t.updated_at)),
    h('div', { class: 'title' }, t.title),
    t.assignee && h('div', { class: 'card-foot' }, who(t.assignee),
      mine && h('span', { class: 'assignment-cue' }, 'Assigned to you')))
  S.cards.set(t.id, { t, el })
  return el
}

// Place a ticket from the realtime stream (or a local edit) where the server would list it.
function upsert(t, flash) {
  const old = S.cards.get(t.id)
  if (old) { old.el.remove(); S.cards.delete(t.id); const c = S.cols.get(old.t.column); if (c) c.offset-- }
  const col = matches(t) && S.cols.get(t.column)
  if (!col) return
  const next = [...col.cards.children].find(el => el.dataset.id && byPos(t, S.cards.get(+el.dataset.id).t) < 0)
  if (!next && !col.done) return // belongs past the loaded page; pagination will bring it
  const el = card(t); col.cards.insertBefore(el, next || col.more); col.offset++
  if (flash) { el.classList.add('flash'); el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true }) }
}

async function drop(e, col) {
  e.preventDefault(); col.cards.classList.remove('drop')
  const id = +e.dataTransfer.getData('text/plain'), moving = S.cards.get(id)
  if (!moving) return
  const cards = [...col.cards.querySelectorAll('.card')].filter(c => +c.dataset.id !== id)
  const i = cards.findIndex(c => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 })
  const pos = el => S.cards.get(+el.dataset.id).t.position
  const position = !cards.length ? undefined : i === 0 ? pos(cards[0]) - 1 : i === -1 ? pos(cards.at(-1)) + 1 : (pos(cards[i - 1]) + pos(cards[i])) / 2
  attempt(async () => upsert(await api('PATCH', '/tickets/' + id, { column: col.slug, position })))()
}
// Dropping a file outside a composer must not navigate away from the board.
window.addEventListener('dragover', e => e.dataTransfer.types.includes('Files') && e.preventDefault())
window.addEventListener('drop', e => e.dataTransfer.types.includes('Files') && e.preventDefault())

let countsTimer
const refreshCounts = () => { clearTimeout(countsTimer); countsTimer = setTimeout(attempt(async () => {
  const b = await api('GET', '/board' + qs(S.f))
  b.columns.forEach(c => { const col = S.cols.get(c.slug); if (col) col.count.textContent = c.count })
}), 300) }

function renderFilters() {
  $('#f-project').replaceChildren(...options([['', 'All projects'], ['none', 'No project'], ...S.board.projects.map(x => [x.name, x.name])], S.f.project))
  $('#f-assignee').replaceChildren(...options([['', 'Anyone'], ['none', 'Unassigned'], ...S.board.users.map(u => [u.name, u.name])], S.f.assignee))
}
function setFilter(k, v) {
  S.f[k] = v
  history.replaceState(null, '', location.pathname + qs(S.f) + location.hash)
  loadBoard()
}
let qTimer
$('#f-q').oninput = e => { clearTimeout(qTimer); qTimer = setTimeout(() => setFilter('q', e.target.value), 250) }
$('#f-project').onchange = e => setFilter('project', e.target.value)
$('#f-assignee').onchange = e => setFilter('assignee', e.target.value)
setInterval(() => document.querySelectorAll('[data-time]').forEach(el => { el.textContent = ago(el.dataset.time) }), 60e3)

// ---------- realtime
function connect() {
  const es = new EventSource('/api/stream'), live = $('#live')
  let dropped = false
  es.onopen = () => { live.classList.add('on'); live.title = 'Live'; if (dropped) { dropped = false; attempt(refreshIdentity)(); loadBoard(); refreshTicket() } }
  es.onerror = () => { live.classList.remove('on'); live.title = 'Reconnecting…'; dropped = true; attempt(refreshIdentity)() }
  es.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.type === 'meta') return loadBoard()
    if (m.ticket) upsert(m.ticket, true)
    else { const old = S.cards.get(m.id); if (old) { old.el.remove(); S.cards.delete(m.id) } }
    refreshCounts()
    m.events.forEach(ev => feedItem(ev))
    if (openId === m.id) m.ticket ? refreshTicket() : dlg.close()
  }
}

// ---------- events (feed + timeline)
const EVENTS = {
  created: ['plus', () => 'created'],
  comment: ['message-square', () => 'commented'],
  moved: ['arrow-right', ev => ['moved to ', h('b', {}, ev.body.split(' → ').pop())]],
  assigned: ['user', ev => ev.body ? ['assigned ', h('b', {}, ev.body)] : 'unassigned'],
  edited: ['pencil', ev => 'edited ' + ev.body],
  deleted: ['trash-2', ev => ['deleted ', h('b', {}, ev.body)]],
}
const describe = ev => (EVENTS[ev.type] || ['activity', () => ev.type])[1](ev)
// One-line plain-text preview of a markdown comment.
const plain = src => src.replace(/!?\[([^\]]*)\]\(\/files\/[^)]*\)/g, '📎 $1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+|\[[ x]\]\s*/gim, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)
function feedItem(ev, append) {
  const feed = $('#feed'); if (!feed.loaded) return
  const li = h('li', { onclick: () => ev.ticket_id && (location.hash = ev.ticket_id) },
    ev.user ? avatar(ev.user, ev.user_kind) : h('span'),
    h('div', { class: 'meta' }, h('span', { class: 'what' }, h('b', {}, ev.user || 'someone'), ' ', describe(ev),
      ev.ticket_id && [' ', h('b', {}, '#' + ev.ticket_id)]), h('span', { class: 'grow' }), time(ev.created_at)),
    ev.ticket_title && h('div', { class: 'snippet' }, ev.type === 'comment' ? plain(ev.body) : ev.ticket_title))
  append ? feed.append(li) : feed.prepend(li)
  while (feed.children.length > 300) feed.lastChild.remove()
}
async function toggleActivity() {
  const a = $('#activity'), open = a.classList.toggle('open'); store.set('activity', open ? '1' : '0')
  if (open && !$('#feed').loaded) { const evs = await api('GET', '/events?limit=100'); $('#feed').loaded = true; evs.reverse().forEach(ev => feedItem(ev, true)) }
}
$('#btn-activity').onclick = $('#btn-activity-close').onclick = attempt(toggleActivity)

// ---------- markdown + attachments
function mdEl(src) {
  const el = h('div', { class: 'md' }); el.innerHTML = md.render(src || '')
  el.querySelectorAll('a[href^="/files/"]').forEach(a => { a.classList.add('file'); a.prepend(icon('paperclip')) })
  el.querySelectorAll('img').forEach(img => { img.loading = 'lazy' })
  return el
}
const lightbox = $('#lightbox')
lightbox.onclick = () => lightbox.close()
document.addEventListener('click', e => {
  if (e.target.tagName === 'IMG' && e.target.closest('.md')) { lightbox.querySelector('img').src = e.target.src; lightbox.showModal() }
})

// A markdown box with multi-file attachments (button, paste or drop). Files upload immediately; markdown is appended on submit.
function composer({ value = '', placeholder, rows = 3, label, iconName = 'send', onSubmit, onCancel }) {
  const ta = h('textarea', { rows, placeholder, value }), tray = h('div', { class: 'tray' }), pending = []
  const remove = item => { item.chip.remove(); const i = pending.indexOf(item); if (i >= 0) pending.splice(i, 1) }
  const add = file => {
    const chip = h('div', { class: 'chip loading' }, file.type.startsWith('image/') ? h('img', { src: URL.createObjectURL(file), alt: '' }) : icon('file-text'),
      h('span', { class: 'name' }, file.name || 'file'))
    const item = { chip }
    item.done = api('POST', '/files?name=' + encodeURIComponent(file.name || 'file'), file)
      .then(r => { item.file = r; chip.classList.remove('loading') }, e => { remove(item); toast(`${file.name}: ${e.message}`) })
    chip.append(btn('x', 'Remove ' + (file.name || 'file'), () => remove(item), 'ghost icon sm'))
    pending.push(item); tray.append(chip)
  }
  const addAll = files => [...files].forEach(add)
  const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { addAll(input.files); input.value = '' } })
  ta.addEventListener('paste', e => { if (e.clipboardData.files.length) { e.preventDefault(); addAll(e.clipboardData.files) } })
  let busy = false
  const submit = async () => {
    if (busy) return; busy = true
    try {
      await Promise.all(pending.map(p => p.done))
      const files = pending.filter(p => p.file).map(p => p.file)
      const text = [ta.value.trim(), files.filter(f => f.image).map(f => f.markdown).join(' '), files.filter(f => !f.image).map(f => f.markdown).join(' ')]
        .filter(Boolean).join('\n\n')
      if (!text && !onCancel) return
      await onSubmit(text)
      ta.value = ''; pending.splice(0); tray.replaceChildren()
    } catch (e) { toast(e.message) } finally { busy = false }
  }
  ta.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }
  const el = h('div', { class: 'composer',
    ondragover: e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); el.classList.add('over') } },
    ondragleave: e => { if (!el.contains(e.relatedTarget)) el.classList.remove('over') },
    ondrop: e => { el.classList.remove('over'); if (e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); addAll(e.dataTransfer.files) } } },
    ta, tray, h('div', { class: 'bar' }, input, btn('paperclip', 'Attach files', () => input.click()), h('span', { class: 'faint hint' }, '⌘↵'),
      h('span', { class: 'grow' }), onCancel && h('button', { type: 'button', class: 'btn ghost', onclick: onCancel }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: submit }, icon(iconName), label)))
  return { el, ta }
}

// ---------- ticket dialog
let openId = null
const dlg = $('#ticket')
dlg.addEventListener('close', () => { openId = null; if (location.hash) history.replaceState(null, '', location.pathname + location.search) })
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close() })
window.addEventListener('hashchange', route)
function route() { const id = +location.hash.slice(1); id ? openTicket(id) : dlg.open && dlg.close() }
const field = (label, ...kids) => h('label', { class: 'field' }, h('span', {}, label), ...kids)
const selects = (t, onchange) => ({
  column: h('select', { name: 'column', onchange }, options(S.board.columns.map(c => [c.slug, c.name]), t.column)),
  project: h('select', { name: 'project', onchange }, options([['', 'None'], ...S.board.projects.map(p => [p.name, p.name])], t.project)),
  assignee: h('select', { name: 'assignee', onchange }, options([['', 'Unassigned'], ...S.board.users.map(u => [u.name, (u.kind === 'agent' ? '◆ ' : '') + u.name])], t.assignee)),
})

async function openTicket(id) {
  openId = id
  let t
  try { t = await api('GET', '/tickets/' + id) } catch (e) { openId = null; return toast(e.message) }
  if (openId !== id) return
  const patch = async body => upsert(await api('PATCH', '/tickets/' + id, body))
  const sel = selects(t, attempt(e => patch({ [e.target.name]: e.target.value || null })))
  const title = h('input', { class: 'title-input', 'aria-label': 'Title', onchange: attempt(e => e.target.value.trim() && patch({ title: e.target.value.trim() })) })
  const pill = h('span', { class: 'pill' }), createdBy = h('div', { class: 'dim' }), repo = h('div')
  const desc = h('div'), linkList = h('div', { class: 'links' }), timeline = h('div', { class: 'timeline' })
  let editing = false, seen = null
  const showDesc = () => desc.replaceChildren(h('div', { class: 'desc' }, mdEl(t.body || '_No description yet._')))
  const editDesc = () => {
    editing = true
    const c = composer({ value: t.body, rows: 10, label: 'Save', iconName: 'check', placeholder: 'Description (markdown)',
      onSubmit: async text => { await patch({ body: text }); editing = false; refreshTicket() }, onCancel: () => { editing = false; showDesc() } })
    desc.replaceChildren(c.el); c.ta.focus()
  }
  const linkAdd = h('input', { placeholder: 'Add link (repo, PR, doc)…', type: 'url' })
  linkAdd.onkeydown = attempt(async e => { if (e.key === 'Enter' && linkAdd.value.trim()) { await patch({ links: [...t.links, linkAdd.value.trim()] }); linkAdd.value = '' } })
  // Redraws everything the user isn't touching, so realtime updates never eat a draft.
  const render = fresh => {
    t = fresh
    if (title !== document.activeElement || title.value === title.dataset.was) title.value = title.dataset.was = t.title
    Object.values(sel).forEach(s => { if (s !== document.activeElement) s.value = t[s.name] || '' })
    pill.textContent = S.board.columns.find(c => c.slug === t.column)?.name ?? t.column
    createdBy.replaceChildren(who(t.created_by), h('div', { class: 'faint' }, 'created ', time(t.created_at), ' · updated ', time(t.updated_at)))
    const r = project(t.project)?.repo
    repo.replaceChildren(r ? h('a', { class: 'link', href: r, target: '_blank', rel: 'noopener noreferrer' }, icon('folder-git-2'), shortLink(r)) : '')
    if (!editing) showDesc()
    linkList.replaceChildren(...t.links.map((u, i) => h('div', { class: 'link' }, icon(linkIcon(u)), h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', title: u }, shortLink(u)),
      btn('x', 'Remove link', attempt(() => patch({ links: t.links.filter((_, j) => j !== i) })), 'ghost icon sm'))))
    const fresh_ = ev => seen && !seen.has(ev.id) ? ' enter' : '' // animate only what arrived since the last render
    timeline.replaceChildren(...t.events.map(ev => ev.type === 'comment'
      ? h('div', { class: 'comment' + fresh_(ev) }, h('div', { class: 'meta' }, who(ev.user), time(ev.created_at)), mdEl(ev.body))
      : h('div', { class: 'ev' + fresh_(ev) }, icon(EVENTS[ev.type]?.[0] || 'activity'), h('b', {}, ev.user || 'someone'), h('span', {}, describe(ev)), time(ev.created_at))))
    seen = new Set(t.events.map(ev => ev.id))
  }
  const comment = composer({ placeholder: 'Write a comment… (markdown, paste or drop files)', label: 'Comment',
    onSubmit: text => api('POST', `/tickets/${id}/comments`, { body: text }) })
  render(t)
  dlg.replaceChildren(
    h('div', { class: 'dlg-top' }, h('span', { class: 'id' }, '#' + id), pill, h('span', { class: 'grow' }),
      btn('trash-2', 'Delete ticket', attempt(async () => { if (confirm(`Delete #${id} “${t.title}”?`)) await api('DELETE', '/tickets/' + id) }), 'ghost icon danger'),
      btn('x', 'Close', () => dlg.close())),
    h('div', { class: 'dlg-body' }, title, h('div', { class: 'ticket-grid' },
      h('div', { class: 'ticket-main' },
        h('div', { class: 'section-head' }, 'Description', btn('pencil', 'Edit description', editDesc, 'ghost icon sm')), desc,
        h('div', { class: 'section-head' }, 'Activity'), timeline, comment.el),
      h('div', { class: 'side' }, field('Column', sel.column), field('Project', sel.project, repo), field('Assignee', sel.assignee),
        h('div', { class: 'field' }, h('span', {}, 'Links'), linkList, linkAdd), h('div', { class: 'field' }, h('span', {}, 'Created by'), createdBy)))))
  dlg.refresh = async () => { const fresh = await api('GET', '/tickets/' + id); if (openId === id) render(fresh) }
  if (!dlg.open) dlg.showModal()
}
function refreshTicket() { if (openId && dlg.refresh) attempt(dlg.refresh)() }

$('#btn-new').onclick = () => {
  openId = null
  const title = h('input', { class: 'title-input', placeholder: 'Ticket title', 'aria-label': 'Title' })
  const sel = selects({ column: S.board.columns[0]?.slug, project: S.f.project !== 'none' ? S.f.project : '', assignee: S.f.assignee !== 'none' ? S.f.assignee : '' })
  const c = composer({ rows: 6, label: 'Create', iconName: 'plus', placeholder: 'Description (markdown, paste or drop files)',
    onSubmit: async body => {
      if (!title.value.trim()) { title.focus(); throw new Error('Title is required') }
      const t = await api('POST', '/tickets', { title: title.value.trim(), body, column: sel.column.value, project: sel.project.value || null, assignee: sel.assignee.value || null })
      upsert(t, true); location.hash = t.id
    }, onCancel: () => dlg.close() })
  dlg.replaceChildren(h('div', { class: 'dlg-top' }, h('b', {}, 'New ticket'), h('span', { class: 'grow' }), btn('x', 'Close', () => dlg.close())),
    h('div', { class: 'dlg-body ticket-main' }, title, h('div', { class: 'row' }, field('Column', sel.column), field('Project', sel.project), field('Assignee', sel.assignee)), c.el))
  dlg.showModal(); title.focus()
}

// ---------- settings
const sdlg = $('#settings')
sdlg.addEventListener('click', e => { if (e.target === sdlg) sdlg.close() })
$('#btn-settings').onclick = attempt(async () => { await renderSettings(); sdlg.showModal() })
$('#btn-logout').onclick = attempt(async () => { await api('POST', '/logout'); authChanged(); location.reload() })
const randomColor = () => '#' + [0, 0, 0].map(() => (96 + Math.random() * 144 | 0).toString(16)).join('')

async function renderSettings(keyNotice) {
  const [board, users] = await Promise.all([api('GET', '/board'), api('GET', '/users')])
  const act = fn => attempt(async (...a) => { await fn(...a); await renderSettings() })
  const addForm = (onsubmit, ...fields) => h('form', { class: 'add', onsubmit: e => { e.preventDefault(); onsubmit() } }, ...fields, h('button', { class: 'btn primary' }, icon('plus'), 'Add'))
  const tab = (key, iconName, label) => h('button', { type: 'button', class: 'btn' + (S.tab === key ? ' on' : ''), onclick: () => { S.tab = key; renderSettings() } }, icon(iconName), label)
  const enc = encodeURIComponent
  let body
  if (S.tab === 'columns') {
    const name = h('input', { placeholder: 'New column name', required: true })
    body = [h('div', { class: 'list' }, board.columns.map((c, i) => h('div', { class: 'item' },
      h('input', { class: 'ghost-input grow', value: c.name, 'aria-label': 'Column name', onchange: act(e => api('PATCH', '/columns/' + c.slug, { name: e.target.value })) }),
      h('span', { class: 'count' }, c.count),
      h('div', { class: 'actions' },
        btn('chevron-left', 'Move left', act(() => api('PATCH', '/columns/' + c.slug, { index: i - 1 })), 'ghost icon sm'),
        btn('chevron-right', 'Move right', act(() => api('PATCH', '/columns/' + c.slug, { index: i + 1 })), 'ghost icon sm'),
        btn('trash-2', 'Delete column', act(() => api('DELETE', '/columns/' + c.slug)), 'ghost icon sm danger'))))),
      addForm(act(() => api('POST', '/columns', { name: name.value })), name)]
  } else if (S.tab === 'projects') {
    const name = h('input', { placeholder: 'New project name', required: true })
    const repoUrl = v => v.trim() ? v.trim().replace(/^(?!https?:\/\/)/, 'https://') : null
    body = [h('div', { class: 'list' }, board.projects.map(p => h('div', { class: 'item' },
      h('input', { type: 'color', class: 'swatch', value: p.color, 'aria-label': 'Color', onchange: act(e => api('PATCH', '/projects/' + enc(p.name), { color: e.target.value })) }),
      h('input', { class: 'ghost-input', value: p.name, size: 14, 'aria-label': 'Project name', onchange: act(e => api('PATCH', '/projects/' + enc(p.name), { name: e.target.value })) }),
      h('input', { class: 'ghost-input grow', value: p.repo, placeholder: 'github.com/owner/repo', 'aria-label': 'Repository URL',
        onchange: act(e => api('PATCH', '/projects/' + enc(p.name), { repo: repoUrl(e.target.value) })) }),
      h('div', { class: 'actions' }, btn('trash-2', 'Delete project', act(() => confirm(`Delete project ${p.name}? Its tickets stay.`) && api('DELETE', '/projects/' + enc(p.name))), 'ghost icon sm danger'))))),
      addForm(act(() => api('POST', '/projects', { name: name.value, color: randomColor() })), name)]
  } else {
    const agent = S.newKind === 'agent'
    const name = h('input', { placeholder: agent ? 'agent-name' : 'username', required: true, pattern: '[\\w.\\-]+', title: 'letters, digits, _ . -' })
    const email = h('input', { type: 'email', placeholder: 'email', required: true }), password = h('input', { type: 'password', placeholder: 'password (8+)', minlength: 8, required: true })
    const showKey = (n, key) => renderSettings(h('div', { class: 'keybox' }, icon('key-round'),
      h('div', { class: 'grow' }, h('div', { class: 'dim' }, `API key for ${n}, shown once:`), h('code', {}, key)), btn('copy', 'Copy key', () => copy(key))))
    body = [keyNotice, h('div', { class: 'list' }, users.map(u => h('div', { class: 'item' },
      h('span', { class: 'who grow' }, avatar(u.name, u.kind), u.name, h('span', { class: 'faint' }, u.email || (u.has_key ? 'API key' : ''))),
      h('div', { class: 'actions' },
        btn('key-round', 'New API key', attempt(async () => confirm(`Issue a new API key for ${u.name}? The old one stops working immediately.`) && showKey(u.name, (await api('POST', `/users/${enc(u.name)}/key`)).key)), 'ghost icon sm'),
        u.name !== S.me.name && btn('trash-2', 'Delete user', act(() => confirm(`Delete ${u.name}?`) && api('DELETE', '/users/' + enc(u.name))), 'ghost icon sm danger'))))),
      h('div', { class: 'tabs kind' }, ...[['agent', 'bot', 'Agent'], ['human', 'user', 'Human']].map(([k, i, l]) =>
        h('button', { type: 'button', class: 'btn' + (S.newKind === k ? ' on' : ''), onclick: () => { S.newKind = k; renderSettings() } }, icon(i), l))),
      agent
        ? addForm(attempt(async () => showKey(name.value, (await api('POST', '/users', { kind: 'agent', name: name.value })).key)), name)
        : addForm(act(() => api('POST', '/users', { kind: 'human', name: name.value, email: email.value, password: password.value })), name, email, password)]
  }
  sdlg.replaceChildren(
    h('div', { class: 'dlg-top' }, h('div', { class: 'tabs' }, tab('columns', 'columns-3', 'Columns'), tab('projects', 'folder-git-2', 'Projects'), tab('people', 'users', 'People')),
      h('span', { class: 'grow' }), btn('x', 'Close', () => sdlg.close())),
    h('div', { class: 'dlg-body' }, body,
      h('p', { class: 'faint footnote' }, 'Agents read the API docs at ', h('a', { href: '/api', target: '_blank' }, location.origin + '/api'))))
}
function copy(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text).then(() => toast('Copied', false), () => toast('Copy failed; select the key instead'))
  const r = document.createRange(); r.selectNodeContents(sdlg.querySelector('.keybox code')); getSelection().removeAllRanges(); getSelection().addRange(r)
  toast(document.execCommand('copy') ? 'Copied' : 'Select the key and copy it', false)
}

start()
