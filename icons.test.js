import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Firefox applies host CSS selectors inside external <use> shadow trees.
// Keep panel layout/visibility rules from matching the activity SVG symbol.
test('activity panel CSS cannot hide the activity sprite symbol', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8')
  const selectors = css.match(/[^{}]+(?={)/g).filter(s => s.includes('#activity'))
  assert.ok(selectors.length > 0)
  for (const selector of selectors) {
    assert.match(selector, /aside#activity/)
    assert.doesNotMatch(selector.replaceAll('aside#activity', ''), /#activity/)
  }
  const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
  assert.match(html, /<aside id="activity"/)
  assert.match(html, /id="btn-activity"[^>]*title="Activity"[^>]*aria-label="Activity"/)
  assert.ok(html.includes('href="/icons.svg#activity"'))
})
