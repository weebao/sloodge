/**
 * Does `wrapSlideHtml`'s injected `<meta http-equiv="Content-Security-Policy">` actually end up
 * where the document honours it?
 *
 * Finding a `<head>` *tag* is not the same as the tree builder keeping it. Non-whitespace text, or
 * any start tag that is not head content, closes the implied head and opens the body; a `<head>`
 * token after that is a parse error and is discarded. A meta injected there is a child of `<body>`,
 * and HTML's CSP pragma processing returns early for a meta whose parent is not the head — so the
 * whole layer-3 policy is silently dropped.
 *
 * This measures both halves against real Chromium, using the **real** `wrapSlideHtml`:
 *
 *   PLACEMENT   `document.head.querySelector('meta[http-equiv="Content-Security-Policy"]')` — a
 *               *structural* question asked of the parsed tree.
 *   ENFORCEMENT re-point the injected policy at `script-src 'none'`, give the probe an inline
 *               script that stamps `data-inline="RAN"`, and check the stamp is absent — i.e. the
 *               policy was really applied, not merely present in the tree.
 *
 * The placement oracle used to slice the serialized DOM between `<head>` and `</head>` and look for
 * the string `Content-Security-Policy`. That reported a **false pass** for the `noframes` probe,
 * where the policy was raw *text* inside `<noframes>` rather than an element — only the enforcement
 * canary caught it. A substring cannot tell an element from text that looks like one, so the
 * question is now asked of the DOM. Evaluation runs over CDP, which is not subject to the page's
 * own CSP, so the enforcing variant can still be interrogated.
 *
 * Run (needs the playwright browsers this harness already downloads):
 *
 *     node experiments/init/harness/csp-meta-placement.mjs
 *
 * Measured 2026-07-31, Chromium via Playwright: all 19 probes PASS both halves. Each fix in this
 * file's history was proven by the corresponding probe going red first: before the implied-body
 * fix, probes 1-3 failed both halves; before the `noframes`/`template` fixes, those two did.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { wrapSlideHtml } from '../../../src/renderer/src/features/canvas/wrapSlideHtml.ts'

/** An inline script that marks the document if the CSP failed to stop it. */
const CANARY = `<script>document.documentElement.setAttribute('data-inline','RAN')</script>`

const PROBES = [
  ['implied body: text', `<!doctype html><html>hello<head><title>t</title></head><body>${CANARY}`],
  ['implied body: <div>', `<!doctype html><html><div></div><head></head><body>${CANARY}`],
  ['implied body: <p>x', `<!doctype html><html><p>x<head></head><body>${CANARY}`],
  ['control: <style> first', `<!doctype html><html><style>.a{}</style><head></head><body>${CANARY}`],
  ['control: plain head', `<!doctype html><html><head><title>t</title></head><body>${CANARY}`],
  ['decoy: head in comment', `<!doctype html><html><!-- <head> --><head></head><body>${CANARY}`],
  ['decoy: head in script', `<!doctype html><html><script>var s="<head>"</script><head></head><body>${CANARY}`],
  ['decoy: head in title', `<!doctype html><html><title>a<head>b</title><body>${CANARY}`],
  ['decoy: head in noscript', `<!doctype html><html><noscript><head></noscript><body>${CANARY}`],
  ['decoy: double-escaped', `<!doctype html><html><script>/*<!--<script>*/</script><head></head><body>${CANARY}`],
  ['decoy: head in attribute', `<!doctype html><html data-n="<head>"><head></head><body>${CANARY}`],
  // RAWTEXT *and* head content: it must be skipped as text without implying a body.
  ['decoy: head in noframes', `<!doctype html><html><noframes><head></noframes><body>${CANARY}`],
  // Template children parse into a separate DocumentFragment, so a meta there is not in the head.
  ['decoy: head in template', `<!doctype html><html><template><head></head></template><body>${CANARY}`],
  // End tags that cascade past the head: before-head -> in-head -> after-head -> body inserted.
  ['end tag: </br>', `<!doctype html><html></br><head></head><body>${CANARY}`],
  ['end tag: </html>', `<!doctype html><html></html><head></head><body>${CANARY}`],
  ['end tag: <meta> then </br>', `<!doctype html><html><meta charset="utf-8"></br><head></head><body>${CANARY}`],
  // Control: `</p>` is a parse error in these modes and is ignored, so the head is still open.
  ['control: ignored </p>', `<!doctype html><html></p><head></head><body>${CANARY}`],
  ['fallback: no head', `<!doctype html><html><body>${CANARY}`],
  ['fallback: bare fragment', `<p>hi</p>${CANARY}`],
]

const dir = mkdtempSync(join(tmpdir(), 'sloodge-csp-'))
const browser = await chromium.launch()
const page = await browser.newPage()

async function load(html, name) {
  const file = join(dir, `${name}.html`)
  writeFileSync(file, html)
  await page.goto(pathToFileURL(file).href)
}

let failures = 0
for (const [label, source] of PROBES) {
  const slug = label.replaceAll(/\W+/g, '_')
  const wrapped = wrapSlideHtml(source)

  // Structural: is the policy a real <meta> element whose parent is the head?
  await load(wrapped, slug)
  const placement = await page.evaluate(
    () => document.head.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null,
  )

  // Same placement, a policy that must visibly bite. Ground truth: markup that merely *contains*
  // a policy proves nothing; a policy that blocks the canary proves it was applied.
  await load(wrapped.replace(/content="[^"]*"/, `content="script-src 'none'"`), `${slug}_enf`)
  const enforced = await page.evaluate(
    () => document.documentElement.getAttribute('data-inline') !== 'RAN',
  )

  const ok = placement && enforced
  if (!ok) failures += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} meta-in-head=${String(placement).padEnd(5)} inline-blocked=${String(enforced)}`,
  )
}

await browser.close()
console.log(failures === 0 ? '\nAll probes pass.' : `\n${String(failures)} probe(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
