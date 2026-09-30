import markdownit from '/vendor/markdown-it.mjs'
const md = markdownit({ html: false, linkify: true, breaks: true })
const defaultLink = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o))
md.renderer.rules.link_open = (tokens, i, o, e, self) => { tokens[i].attrSet('target', '_blank'); tokens[i].attrSet('rel', 'noopener'); return defaultLink(tokens, i, o, e, self) }

const $ = s => document.querySelector(s)
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'value') continue
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v)
  }
  el.append(...kids.flat().filter(k => k != null && k !== false))
  if ('value' in attrs) el.value = attrs.value ?? ''
  return el
}
const mdEl = (src, cls = 'md') => { const el = h('div', { class: cls }); el.innerHTML = md.render(src || ''); return el } // markdown-it html:false escapes raw HTML
const options = (list, value) => list.map(([v, label]) => h('option', { value: v, selected: v === value }, label))
const qs = o => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)); return p.size ? '?' + p : '' }
const ago = t => { const s = (Date.now() - new Date(t)) / 1e3; return s < 60 ? 'now' : s < 3600 ? `${s / 60 | 0}m` : s < 86400 ? `${s / 3600 | 0}h` : `${s / 86400 | 0}d` }
const store = { get: k => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }
const shortLink = u => {
  const m = /^https?:\/\/github\.com\/([^/]+\/[^/#?]+)(?:\/(?:pull|issues)\/(\d+))?/.exec(u)
  return m ? m[1] + (m[2] ? '#' + m[2] : '') : u.replace(/^https?:\/\//, '').slice(0, 60)
}

async function api(method, url, body) {
  const blob = body instanceof Blob
  const r = await fetch('/api' + url, { method, body: blob ? body : body && JSON.stringify(body),
    headers: blob ? { 'Content-Type': body.type } : body ? { 'Content-Type': 'application/json' } : {} })
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text()
  if (!r.ok) {
    if (r.status === 401 && S.me && !url.startsWith('/log')) location.reload()
    throw Object.assign(new Error(data.error || r.statusText), { status: r.status, data })
  }
  return data
}
const attempt = fn => async (...a) => { try { await fn(...a) } catch (e) { alert(e.message) } }

const S = { me: null, board: null, cols: new Map(), cards: new Map(), gen: 0,
  f: Object.fromEntries(['q', 'project', 'assignee'].map(k => [k, new URLSearchParams(location.search).get(k) || ''])) }

// ---------- auth
async function start() {
  try { S.me = await api('GET', '/me') } catch (e) { return showAuth(e.data?.setup) }
  $('#app').hidden = false
  $('#btn-logout').textContent = S.me.name + ' ⎋'
  for (const k of ['q', 'project', 'assignee']) $('#f-' + k).value = S.f[k]
  connect()
  await loadBoard()
  if (store.get('activity') === '1') toggleActivity()
  route()
}
function showAuth(setup) {
  const f = $('#auth'); f.hidden = false
  const el = f.elements
  el.name.hidden = !setup; el.name.required = !!setup
  f.querySelector('button').textContent = setup ? 'Create account' : 'Sign in'
  $('#auth-hint').textContent = setup ? 'First run: create the owner account.' : ''
  f.onsubmit = async e => {
    e.preventDefault()
    try {
      await api('POST', setup ? '/setup' : '/login', { name: el.name.value, email: el.email.value, password: el.password.value })
      location.reload()
    } catch (err) { $('#auth-error').textContent = err.message }
  }
}

// ---------- board
const matches = t => {
  const { q, project, assignee } = S.f, eq = (a, b) => (a || '').toLowerCase() === b.toLowerCase()
  const who = assignee === 'me' ? S.me.name : assignee
  const id = /^#?(\d+)$/.exec(q.trim())
  return (!project || (project === 'none' ? !t.project : eq(t.project, project)))
    && (!assignee || (assignee === 'none' ? !t.assignee : eq(t.assignee, who)))
    && (!q || (id ? t.id === +id[1] : t.title.toLowerCase().includes(q.toLowerCase())))
}
const byPos = (a, b) => a.position - b.position || a.id - b.id
const project = name => S.board.projects.find(p => p.name === name)
const userKind = name => S.board.users.find(u => u.name === name)?.kind
const flair = name => { const p = project(name); return p && h('span', { class: 'flair', style: `color:${p.color};border-color:${p.color}88` }, p.name) }
const who = name => name && h('span', { class: 'who ' + (userKind(name) || '') }, name)

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
    col.count = h('span', {}, c.count)
    col.more = h('div', { class: 'more' }); col.more.col = col
    col.cards = h('div', { class: 'cards', ondragover: e => { e.preventDefault(); col.cards.classList.add('drop') },
      ondragleave: () => col.cards.classList.remove('drop'), ondrop: e => drop(e, col) }, col.more)
    S.cols.set(c.slug, col)
    return h('section', { class: 'col' }, h('h2', {}, c.name, col.count), col.cards)
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
  const el = h('article', { class: 'card', draggable: 'true', 'data-id': t.id, onclick: () => { location.hash = t.id },
    ondragstart: e => { e.dataTransfer.setData('text/plain', t.id); el.classList.add('dragging') },
    ondragend: () => el.classList.remove('dragging') },
    h('div', { class: 'meta' }, h('span', {}, '#' + t.id), flair(t.project), h('span', { class: 'grow' }),
      h('span', { 'data-time': t.updated_at, title: new Date(t.updated_at).toLocaleString() }, ago(t.updated_at))),
    h('div', { class: 'title' }, t.title),
    t.assignee && h('div', { class: 'meta' }, who(t.assignee)))
  S.cards.set(t.id, { t, el })
  return el
}

// Place a ticket from the realtime stream (or a local edit) where the server would list it.
function upsert(t, flash) {
  const old = S.cards.get(t.id)
  if (old) { old.el.remove(); S.cards.delete(t.id); const c = S.cols.get(old.t.column); if (c) c.offset-- }
  const col = t && matches(t) && S.cols.get(t.column)
  if (!col) return
  const next = [...col.cards.children].find(el => el.dataset.id && byPos(t, S.cards.get(+el.dataset.id).t) < 0)
  if (!next && !col.done) return // belongs past the loaded page; pagination will bring it
  const el = card(t); col.cards.insertBefore(el, next || col.more); col.offset++
  if (flash) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 60) }
}

async function drop(e, col) {
  e.preventDefault(); col.cards.classList.remove('drop')
  const id = +e.dataTransfer.getData('text/plain'), moving = S.cards.get(id)
  if (!moving) return
  const cards = [...col.cards.querySelectorAll('.card')].filter(c => +c.dataset.id !== id)
  const i = cards.findIndex(c => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 })
  const pos = el => S.cards.get(+el.dataset.id).t.position
  const position = !cards.length ? undefined : i === 0 ? pos(cards[0]) - 1 : i === -1 ? pos(cards.at(-1)) + 1 : (pos(cards[i - 1]) + pos(cards[i])) / 2
  try { upsert(await api('PATCH', '/tickets/' + id, { column: col.slug, position })) } catch (err) { alert(err.message) }
}

let countsTimer
const refreshCounts = () => { clearTimeout(countsTimer); countsTimer = setTimeout(async () => {
  const b = await api('GET', '/board' + qs(S.f))
  b.columns.forEach(c => { const col = S.cols.get(c.slug); if (col) col.count.textContent = c.count })
}, 300) }

function renderFilters() {
  const p = $('#f-project'), a = $('#f-assignee')
  p.replaceChildren(...options([['', 'All projects'], ['none', 'No project'], ...S.board.projects.map(x => [x.name, x.name])], S.f.project))
  a.replaceChildren(...options([['', 'Anyone'], ['me', 'Me'], ['none', 'Unassigned'], ...S.board.users.map(u => [u.name, (u.kind === 'agent' ? '◆ ' : '') + u.name])], S.f.assignee))
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
  const es = new EventSource('/api/stream')
  let dropped = false
  es.onopen = () => { $('#live').classList.add('on'); if (dropped) { dropped = false; loadBoard(); reopenTicket() } }
  es.onerror = () => { $('#live').classList.remove('on'); dropped = true }
  es.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.type === 'meta') return loadBoard()
    if (m.ticket) upsert(m.ticket, true)
    else { const old = S.cards.get(m.id); if (old) { old.el.remove(); S.cards.delete(m.id) } }
    refreshCounts()
    m.events.forEach(feedItem)
    if (openId === m.id) m.ticket ? reopenTicket() : $('#ticket').close()
  }
}

// ---------- activity feed
const describe = ev => ({ created: 'created', comment: 'commented', moved: 'moved → ' + ev.body.split(' → ').pop(),
  assigned: ev.body ? 'assigned ' + ev.body : 'unassigned', edited: 'edited ' + ev.body, deleted: 'deleted ' + ev.body })[ev.type] || ev.type
function feedItem(ev, append) {
  const feed = $('#feed'); if (!feed.loaded) return
  const li = h('li', { onclick: () => ev.ticket_id && (location.hash = ev.ticket_id) },
    h('div', { class: 'meta' }, who(ev.user) || h('span', {}, 'someone'), h('span', {}, describe(ev)), h('span', { class: 'grow' }),
      h('span', { 'data-time': ev.created_at }, ago(ev.created_at))),
    ev.ticket_id && h('div', {}, `#${ev.ticket_id} ${ev.ticket_title || ''}`),
    ev.type === 'comment' && h('div', { class: 'snippet' }, ev.body.slice(0, 200)))
  append ? feed.append(li) : feed.prepend(li)
  while (feed.children.length > 300) feed.lastChild.remove()
}
async function toggleActivity() {
  const a = $('#activity'); a.hidden = !a.hidden; store.set('activity', a.hidden ? '0' : '1')
  if (!a.hidden && !$('#feed').loaded) { const evs = await api('GET', '/events?limit=100'); $('#feed').loaded = true; evs.reverse().forEach(ev => feedItem(ev, true)) }
}
$('#btn-activity').onclick = toggleActivity

// ---------- ticket dialog
let openId = null
const dlg = $('#ticket')
dlg.addEventListener('close', () => { openId = null; if (location.hash) history.replaceState(null, '', location.pathname + location.search) })
dlg.addEventListener('click', e => {
  if (e.target === dlg) dlg.close()
  if (e.target.tagName === 'IMG' && e.target.closest('.md')) window.open(e.target.src, '_blank')
})
window.addEventListener('hashchange', route)
function route() { const id = +location.hash.slice(1); id ? openTicket(id) : dlg.open && dlg.close() }

async function upload(file, textarea) {
  const { markdown } = await api('POST', '/files', file)
  const at = textarea.selectionStart ?? textarea.value.length
  textarea.value = textarea.value.slice(0, at) + markdown + '\n' + textarea.value.slice(at)
}
const imageDrop = ta => {
  const take = files => [...files].filter(f => f.type.startsWith('image/')).forEach(attempt(f => upload(f, ta)))
  ta.addEventListener('paste', e => { if (e.clipboardData.files.length) { e.preventDefault(); take(e.clipboardData.files) } })
  ta.addEventListener('drop', e => { if (e.dataTransfer.files.length) { e.preventDefault(); take(e.dataTransfer.files) } })
  return ta
}
const attachButton = ta => {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true,
    onchange: () => { [...input.files].forEach(attempt(f => upload(f, ta))); input.value = '' } })
  return [input, h('button', { type: 'button', class: 'ghost', onclick: () => input.click() }, 'Attach image')]
}
const fieldSelects = (t, onchange) => h('div', { class: 'row' },
  h('label', {}, 'Column', h('select', { name: 'column', onchange }, options(S.board.columns.map(c => [c.slug, c.name]), t.column))),
  h('label', {}, 'Project', h('select', { name: 'project', onchange }, options([['', '—'], ...S.board.projects.map(p => [p.name, p.name])], t.project || ''))),
  h('label', {}, 'Assignee', h('select', { name: 'assignee', onchange }, options([['', '—'], ...S.board.users.map(u => [u.name, u.name])], t.assignee || ''))))

async function openTicket(id) {
  openId = id
  let t
  try { t = await api('GET', '/tickets/' + id) } catch (e) { openId = null; return alert(e.message) }
  if (openId !== id) return
  const patch = body => api('PATCH', '/tickets/' + id, body).then(upsert)
  const onSelect = attempt(e => patch({ [e.target.name]: e.target.value || null }))
  const header = h('div', {}), bodyView = h('div', { class: 'box' }), linksBox = h('div', { class: 'links' }), timeline = h('div', { class: 'timeline' })
  const done = box => attempt(async body => { await patch(body); box.editing = false; dlg.refresh() })
  const editBody = () => {
    const ta = imageDrop(h('textarea', { rows: 12, value: t.body }))
    bodyView.replaceChildren(ta, h('div', { class: 'row' }, h('button', { onclick: () => done(bodyView)({ body: ta.value }) }, 'Save'),
      h('button', { class: 'ghost', onclick: () => { bodyView.editing = false; render(t) } }, 'Cancel'), ...attachButton(ta)))
    bodyView.editing = true; ta.focus()
  }
  const editLinks = () => {
    const ta = h('textarea', { rows: 3, placeholder: 'One URL per line (repos, PRs, docs)', value: t.links.join('\n') })
    linksBox.replaceChildren(ta, h('button', { onclick: () => done(linksBox)({ links: ta.value.split(/\s+/).filter(Boolean) }) }, 'Save links'))
    linksBox.editing = true; ta.focus()
  }
  // Redraws only what the user isn't editing, so realtime updates never eat a draft.
  const render = fresh => {
    t = fresh
    const repo = project(t.project)?.repo
    if (!header.firstChild) header.append(h('div', { class: 'meta' }), h('input', { class: 'title', 'aria-label': 'Title',
      onchange: e => e.target.value.trim() && attempt(patch)({ title: e.target.value.trim() }) }), fieldSelects(t, onSelect))
    header.firstChild.replaceChildren(h('span', {}, '#' + t.id), h('span', {}, 'by ', who(t.created_by) || 'someone', ' · ', new Date(t.created_at).toLocaleString()))
    const title = header.querySelector('.title')
    if (title !== document.activeElement || title.value === title.dataset.was) title.value = title.dataset.was = t.title
    header.querySelectorAll('select').forEach(sel => { if (sel !== document.activeElement) sel.value = t[sel.name] || '' })
    if (!bodyView.editing) bodyView.replaceChildren(mdEl(t.body || '_No description._'))
    if (!linksBox.editing) linksBox.replaceChildren(...t.links.map(u => h('a', { href: u, target: '_blank', rel: 'noopener' }, shortLink(u))),
      repo && h('a', { href: repo, target: '_blank', rel: 'noopener', class: 'dim' }, 'repo: ' + shortLink(repo)) || '',
      h('button', { class: 'ghost', onclick: editLinks }, t.links.length ? 'Edit links' : '+ Links'))
    timeline.replaceChildren(...t.events.map(ev => ev.type === 'comment'
      ? h('div', { class: 'ev comment' }, h('div', { class: 'meta' }, who(ev.user) || 'someone', h('span', { title: new Date(ev.created_at).toLocaleString() }, ago(ev.created_at))), mdEl(ev.body))
      : h('div', { class: 'ev' }, who(ev.user) || 'someone', ' ', describe(ev), ' · ', ago(ev.created_at))))
  }
  const comment = imageDrop(h('textarea', { placeholder: 'Comment (markdown, paste or drop images) — ⌘/Ctrl+Enter to send', rows: 3 }))
  const send = attempt(async () => { if (!comment.value.trim()) return; await api('POST', `/tickets/${id}/comments`, { body: comment.value }); comment.value = '' })
  comment.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }
  render(t)
  dlg.replaceChildren(h('div', { class: 'dlg' }, header,
    h('div', { class: 'row' }, h('b', {}, 'Description'), h('button', { class: 'ghost', onclick: editBody }, 'Edit'),
      S.me.kind === 'human' && h('button', { class: 'danger', onclick: attempt(async () => { if (confirm(`Delete #${id}?`)) await api('DELETE', '/tickets/' + id) }) }, 'Delete'),
      h('span', { class: 'grow' }), h('button', { class: 'ghost', onclick: () => dlg.close() }, 'Close')),
    bodyView, linksBox, timeline, comment,
    h('div', { class: 'row' }, h('button', { onclick: send }, 'Comment'), ...attachButton(comment))))
  dlg.refresh = async () => { const fresh = await api('GET', '/tickets/' + id); if (openId === id) render(fresh) }
  if (!dlg.open) dlg.showModal()
}
function reopenTicket() { if (openId && dlg.refresh) attempt(dlg.refresh)() }

$('#btn-new').onclick = () => {
  openId = null
  const title = h('input', { class: 'title', placeholder: 'Title', required: true })
  const body = imageDrop(h('textarea', { rows: 8, placeholder: 'Description (markdown)' }))
  const links = h('textarea', { rows: 2, placeholder: 'Links, one per line (optional)' })
  const selects = fieldSelects({ column: S.board.columns[0]?.slug, project: S.f.project !== 'none' && S.f.project }, null)
  const val = n => selects.querySelector(`[name=${n}]`).value || null
  const create = attempt(async () => {
    if (!title.value.trim()) return title.focus()
    const t = await api('POST', '/tickets', { title: title.value.trim(), body: body.value, column: val('column'), project: val('project'),
      assignee: val('assignee'), links: links.value.split(/\s+/).filter(Boolean) })
    upsert(t); location.hash = t.id
  })
  dlg.replaceChildren(h('div', { class: 'dlg' }, h('h2', {}, 'New ticket'), title, selects, body, links,
    h('div', { class: 'row' }, h('button', { onclick: create }, 'Create'), ...attachButton(body), h('button', { class: 'ghost', onclick: () => dlg.close() }, 'Cancel'))))
  dlg.showModal(); title.focus()
}

// ---------- settings
const sdlg = $('#settings')
sdlg.addEventListener('click', e => { if (e.target === sdlg) sdlg.close() })
$('#btn-settings').onclick = () => { renderSettings(); sdlg.showModal() }
$('#btn-logout').onclick = attempt(async () => { await api('POST', '/logout'); location.reload() })

async function renderSettings(notice) {
  const human = S.me.kind === 'human'
  const [board, users] = await Promise.all([api('GET', '/board'), api('GET', '/users')])
  const act = fn => attempt(async (...a) => { await fn(...a); renderSettings() })
  const showKey = (name, key) => renderSettings(h('div', { class: 'box' }, `API key for ${name} (shown once):`, h('div', { class: 'key' }, key)))
  const newCol = h('input', { placeholder: 'New column' }), newProj = h('input', { placeholder: 'New project' })
  const agentName = h('input', { placeholder: 'agent-name' })
  const hu = { name: h('input', { placeholder: 'name' }), email: h('input', { placeholder: 'email', type: 'email' }), password: h('input', { placeholder: 'password', type: 'password' }) }
  sdlg.replaceChildren(h('div', { class: 'dlg settings' },
    h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'grow' }), h('button', { class: 'ghost', onclick: () => sdlg.close() }, 'Close')),
    notice, !human && h('p', { class: 'dim' }, 'Only humans can change settings.'),
    h('h3', {}, 'Columns'),
    h('table', {}, board.columns.map((c, i) => h('tr', {},
      h('td', {}, h('input', { value: c.name, onchange: act(e => api('PATCH', '/columns/' + c.slug, { name: e.target.value })) })),
      h('td', { class: 'dim' }, c.slug), h('td', { class: 'dim' }, c.count + ' tickets'),
      h('td', {}, h('button', { class: 'ghost', disabled: i === 0, onclick: act(() => api('PATCH', '/columns/' + c.slug, { index: i - 1 })) }, '←'),
        h('button', { class: 'ghost', disabled: i === board.columns.length - 1, onclick: act(() => api('PATCH', '/columns/' + c.slug, { index: i + 1 })) }, '→'),
        h('button', { class: 'danger', onclick: act(() => api('DELETE', '/columns/' + c.slug)) }, 'Delete'))))),
    h('div', { class: 'row' }, newCol, h('button', { onclick: act(() => api('POST', '/columns', { name: newCol.value })) }, 'Add column')),
    h('h3', {}, 'Projects'),
    h('table', {}, board.projects.map(p => h('tr', {},
      h('td', {}, h('input', { type: 'color', value: p.color, onchange: act(e => api('PATCH', '/projects/' + encodeURIComponent(p.name), { color: e.target.value })) })),
      h('td', {}, h('input', { value: p.name, onchange: act(e => api('PATCH', '/projects/' + encodeURIComponent(p.name), { name: e.target.value })) })),
      h('td', {}, h('input', { value: p.repo, placeholder: 'https://github.com/owner/repo', size: 36, onchange: act(e => api('PATCH', '/projects/' + encodeURIComponent(p.name), { repo: e.target.value || null })) })),
      h('td', {}, h('button', { class: 'danger', onclick: act(() => confirm(`Delete project ${p.name}? Tickets keep existing without it.`) && api('DELETE', '/projects/' + encodeURIComponent(p.name))) }, 'Delete'))))),
    h('div', { class: 'row' }, newProj, h('button', { onclick: act(() => api('POST', '/projects', { name: newProj.value, color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0') })) }, 'Add project')),
    h('h3', {}, 'Users'),
    h('table', {}, users.map(u => h('tr', {},
      h('td', {}, who(u.name)), h('td', { class: 'dim' }, u.kind), h('td', { class: 'dim' }, u.email || ''), h('td', { class: 'dim' }, u.has_key ? 'has API key' : ''),
      h('td', {}, h('button', { class: 'ghost', onclick: attempt(async () => confirm(`Issue a new API key for ${u.name}? The old one stops working.`) && showKey(u.name, (await api('POST', `/users/${u.name}/key`)).key)) }, 'New key'),
        u.name !== S.me.name && h('button', { class: 'danger', onclick: act(() => confirm(`Delete user ${u.name}?`) && api('DELETE', '/users/' + u.name)) }, 'Delete'))))),
    h('div', { class: 'row' }, agentName, h('button', { onclick: attempt(async () => showKey(agentName.value, (await api('POST', '/users', { kind: 'agent', name: agentName.value })).key)) }, 'Add agent')),
    h('div', { class: 'row' }, hu.name, hu.email, hu.password, h('button', { onclick: act(() => api('POST', '/users', { kind: 'human', name: hu.name.value, email: hu.email.value, password: hu.password.value })) }, 'Add human')),
    h('p', { class: 'dim' }, 'Agents: ', h('a', { href: '/api', target: '_blank' }, 'API docs'), ' · base URL ', h('code', {}, location.origin))))
}

start()
