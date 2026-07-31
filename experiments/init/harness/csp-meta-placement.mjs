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
 *   PLACEMENT   `--dump-dom` and check the meta is a child of `<head>`.
 *   ENFORCEMENT re-point the injected policy at `script-src 'none'`, give the probe an inline
 *               script that stamps `data-inline="RAN"`, and check the stamp is absent — i.e. the
 *               policy was really applied, not merely present in the markup.
 *
 * Run (needs the playwright browsers this harness already downloads):
 *
 *     node experiments/init/harness/csp-meta-placement.mjs
 *
 * Measured 2026-07-31, chrome-headless-shell 1234: all 13 probes PASS both halves. Before the
 * implied-body fix, probes 1-3 failed both (empty `<head>`, and `data-inline="RAN"`).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { wrapSlideHtml } from '../../../src/renderer/src/features/canvas/wrapSlideHtml.ts'

const SHELL = join(
  process.env.HOME,
  '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
)

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
  ['fallback: no head', `<!doctype html><html><body>${CANARY}`],
  ['fallback: bare fragment', `<p>hi</p>${CANARY}`],
]

const dir = mkdtempSync(join(tmpdir(), 'sloodge-csp-'))

function dumpDom(html, name) {
  const file = join(dir, `${name}.html`)
  writeFileSync(file, html)
  return execFileSync(SHELL, ['--headless', '--disable-gpu', '--dump-dom', pathToFileURL(file).href], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/** The meta is only honoured as a child of <head>. */
function metaIsInHead(dom) {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(dom)
  return head !== null && head[1].includes('Content-Security-Policy')
}

let failures = 0
for (const [label, source] of PROBES) {
  const wrapped = wrapSlideHtml(source)
  const placement = metaIsInHead(dumpDom(wrapped, label.replaceAll(/\W+/g, '_')))

  // Same placement, a policy that must visibly bite.
  const enforcing = wrapped.replace(/content="[^"]*"/, `content="script-src 'none'"`)
  const enforced = !dumpDom(enforcing, `${label.replaceAll(/\W+/g, '_')}_enf`).includes(
    'data-inline="RAN"',
  )

  const ok = placement && enforced
  if (!ok) failures += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} meta-in-head=${String(placement).padEnd(5)} inline-blocked=${String(enforced)}`,
  )
}

console.log(failures === 0 ? '\nAll probes pass.' : `\n${String(failures)} probe(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
