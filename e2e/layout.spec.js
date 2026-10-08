import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// Real frontend, isolated API fixtures: no production credentials or mutations.
const publicFile = name => readFile(new URL('../public/' + name, import.meta.url), 'utf8')
const project = 'A very long project name that must remain readable'
const user = 'AnAgentWithAnUnbrokenNameThatMustNotWidenTheColumn'
const title = 'Keep long ticket titles readable while multiple columns remain visible ' + 'UnbrokenTitle'.repeat(12)
const columns = ['To Do', 'In Progress', 'In Review', 'Done'].map((name, i) => ({ name, slug: ['to-do', 'in-progress', 'in-review', 'done'][i], count: i === 1 ? 1 : 0 }))

async function board(page) {
  let ticket = { id: 42, title, column: 'in-progress', project, assignee: user, assignee_id: 7, position: 0, updated_at: new Date().toISOString() }
  await page.route('http://board.test/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path === '/api/me') return route.fulfill({ json: { id: 7, name: user } })
    if (path === '/api/board') return route.fulfill({ json: { columns, projects: [{ name: project, color: '#7c8cff' }], users: [{ id: 7, name: user, kind: 'agent' }] } })
    if (path === '/api/tickets') return route.fulfill({ json: url.searchParams.get('column') === ticket.column ? [ticket] : [] })
    if (path === '/api/tickets/42' && route.request().method() === 'PATCH') {
      ticket = { ...ticket, ...route.request().postDataJSON() }
      return route.fulfill({ json: ticket })
    }
    if (path === '/api/stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
    if (path === '/vendor/markdown-it.mjs') return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs', import.meta.url), 'utf8') })
    const file = path === '/' ? 'index.html' : path.slice(1)
    if (['index.html', 'app.js', 'theme.js', 'style.css', 'icons.svg'].includes(file)) return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html', body: await publicFile(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto('http://board.test/')
  await expect(page.locator('.col')).toHaveCount(4)
  // Reveal the populated lane so lazy loading works even on phone viewports.
  await page.locator('.col').nth(1).scrollIntoViewIfNeeded()
  await expect(page.locator('.card')).toHaveCount(1)
}

for (const width of [320, 390, 640, 720, 721, 850, 1024, 1920]) {
  test('bounded columns, readable content and board scrolling at ' + width + 'px', async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await board(page)
    await page.locator('.col').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('board.png') })
    const layout = await page.evaluate(() => {
      const board = document.querySelector('#board'), col = document.querySelector('.col'), cards = document.querySelectorAll('.cards'), card = document.querySelector('.card')
      return { widths: [...document.querySelectorAll('.col')].map(c => c.getBoundingClientRect().width), boardWidth: board.clientWidth, scrollWidth: board.scrollWidth, pageWidth: document.documentElement.scrollWidth,
        cardOverflow: card.scrollWidth > card.clientWidth, laneOverflow: [...cards].some(c => c.scrollWidth > c.clientWidth),
        titleHeight: card.querySelector('.title').getBoundingClientRect().height,
        empty: getComputedStyle(cards[0], '::before').content,
        controls: [...document.querySelectorAll('header button, header select, header input')].map(e => ({ left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right })),
        headerCount: col.querySelector('.count').textContent }
    })
    for (const lane of layout.widths) {
      expect(lane).toBeGreaterThanOrEqual(260)
      expect(lane).toBeLessThanOrEqual(300)
      expect(lane).toBe(layout.widths[0])
    }
    expect(layout.pageWidth).toBe(width)
    expect(layout.cardOverflow).toBe(false)
    expect(layout.laneOverflow).toBe(false)
    expect(layout.titleHeight).toBeGreaterThan(40)
    expect(layout.empty).toContain('Nothing here')
    expect(layout.headerCount).toBe('0')
    for (const control of layout.controls) { expect(control.left).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(width) }
    if (width >= 640) expect(layout.boardWidth / (layout.widths[0] + 12)).toBeGreaterThanOrEqual(2)
    const scroll = await page.locator('#board').evaluate(e => { e.scrollLeft = e.scrollWidth; return e.scrollLeft })
    if (layout.scrollWidth > layout.boardWidth) expect(scroll).toBeGreaterThan(0)
    await page.locator('.col').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('board.png') })
  })
}

test('dragging a card into an empty lane still updates its column', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await board(page)
  await page.locator('.card').dragTo(page.locator('.cards').first())
  await expect(page.locator('.col').first().locator('.card')).toHaveCount(1)
  await expect(page.locator('.col').nth(1).locator('.card')).toHaveCount(0)
  await expect(page.locator('.card .assignment-cue')).toHaveText('Assigned to you')
})

test('theme toggle changes the page on the first click and cycles back to the OS theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await board(page)
  const theme = () => page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('theme') || '', document.querySelector('#btn-theme').title])
  expect(await theme()).toEqual(['light', '', 'Theme: system'])
  for (const want of [['dark', 'dark', 'Theme: dark'], ['light', 'light', 'Theme: light'], ['light', '', 'Theme: system']]) {
    await page.locator('#btn-theme').click()
    expect(await theme()).toEqual(want)
  }
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(async () => (await theme())[0]).toBe('dark')
})
