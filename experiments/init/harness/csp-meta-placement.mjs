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
 * This measures three things against real Chromium, using the **real** `wrapSlideHtml`:
 *
 *   PLACEMENT   `document.head.querySelector('meta[http-equiv="Content-Security-Policy"]')` — a
 *               *structural* question asked of the parsed tree.
 *   ENFORCEMENT re-point the injected policy at `script-src 'none'`, give the probe an inline
 *               script that stamps `data-inline="RAN"`, and check the stamp is absent — i.e. the
 *               policy was really applied, not merely present in the tree.
 *   COMPAT MODE `document.compatMode` is identical with and without the injection. Injecting ahead
 *               of a doctype would silently drop the document into quirks, where the slide's box
 *               model stops matching the 1280x720 the format contract measured. Comparing against
 *               the *unwrapped* document is what makes this an assertion about the injector rather
 *               than about the probe input: a document with no doctype is quirks either way.
 *
 * **All three run on every probe, unconditionally, and that is load-bearing.** The whitespace defect
 * (a doctype after U+00A0 is discarded, so the meta landed in `<body>`) was *invisible* to the
 * compat-mode signal: the bare document is quirks too, so wrapped and unwrapped compared equal and
 * the check passed. Only placement and enforcement caught it. A probe that carried fewer signals
 * would be a place for the next defect to hide.
 *
 * The placement oracle used to slice the serialized DOM between `<head>` and `</head>` and look for
 * the string `Content-Security-Policy`. That reported a **false pass** for the `noframes` probe,
 * where the policy was raw *text* inside `<noframes>` rather than an element — only the enforcement
 * canary caught it. A substring cannot tell an element from text that looks like one, so the
 * question is now asked of the DOM. Evaluation runs over CDP, which is not subject to the page's
 * own CSP, so the enforcing variant can still be interrogated.
 *
 * Run:
 *
 *     pnpm --dir experiments/init/harness add -D playwright@1.62.1
 *     npx playwright install chromium
 *     node experiments/init/harness/csp-meta-placement.mjs
 *
 * **`playwright` is not a dependency of the repo, and `experiments/init/harness/node_modules` does
 * not exist in a fresh checkout or in a git worktree** — without the install above the script dies
 * with `ERR_MODULE_NOT_FOUND`. Reviewers working in a worktree have instead symlinked the main
 * checkout's copy (`ln -s <main-checkout>/experiments/init/harness/node_modules
 * experiments/init/harness/node_modules`), which avoids a second browser download; remember to
 * remove the symlink afterwards so it is not committed.
 *
 * ## This corpus outlived the code it was written against
 *
 * Every probe here was added because it broke the *previous* implementation: a markup walk that
 * searched for a literal `<head>` to inject after. Five review rounds found five ways to fool it —
 * a `<head>` in a comment, a script string, an attribute, RCDATA, `<noframes>`, a `<template>`;
 * one pushed into the body by text or a `<div>`; one after `</br>` or `</html>`. That walk is gone;
 * `wrapSlideHtml` now injects immediately after the doctype and never looks for `<head>` at all,
 * which makes every one of these correct by construction rather than by enumeration.
 *
 * The corpus is kept exactly as it was, because it is the part with the evidence in it. It is what
 * proves the simpler implementation is not a regression, and what will catch the next person who
 * decides the injection point should be cleverer.
 *
 * Measured 2026-07-31, Chromium via Playwright: all 32 probes PASS all three checks.
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
  // Degenerate prologues. The injector must step over everything HTML's "initial" insertion mode
  // allows before a doctype, or the meta lands ahead of the doctype and the document goes quirks.
  ['degenerate: no doctype', `<html><head></head><body>${CANARY}`],
  ['degenerate: comment first', `<!-- c --><!doctype html><html><body>${CANARY}`],
  ['degenerate: BOM first', `﻿<!doctype html><html><body>${CANARY}`],
  // Tokenizer forms that "initial" tolerates before a doctype: `?` and an invalid character after
  // `</` are both reconsumed as bogus comments, and `</>` emits nothing. Injecting ahead of the
  // doctype in any of these silently flips the document to quirks mode.
  ['prologue: XML declaration', `<?xml version="1.0" encoding="utf-8"?><!doctype html><html><body>${CANARY}`],
  ['prologue: empty end tag', `</><!doctype html><html><body>${CANARY}`],
  ['prologue: bogus end tag (space)', `</ x><!doctype html><html><body>${CANARY}`],
  ['prologue: bogus end tag (digit)', `</1><!doctype html><html><body>${CANARY}`],
  // HTML closes a comment on `--!>` too; missing that made this look unterminated.
  ['prologue: --!> comment close', `<!-- c --!><!doctype html><html><body>${CANARY}`],
  // Matched by JS `\s` but NOT HTML whitespace: each is a character token that takes the parser out
  // of "initial", so the doctype after it is DISCARDED. Stepping over them injects past a doctype
  // that no longer exists and the meta lands in <body> — the full policy drop. Note the compat-mode
  // signal cannot see this (the bare document is quirks too); placement and enforcement catch it.
  ['ws: U+00A0 before doctype', ` <!doctype html><html><body>${CANARY}`],
  ['ws: U+000B before doctype', `<!doctype html><html><body>${CANARY}`],
  ['ws: U+3000 before doctype', `　<!doctype html><html><body>${CANARY}`],
  ['ws: second BOM before doctype', `﻿﻿<!doctype html><html><body>${CANARY}`],
  // Control: U+0085 is not in JS `\s` either, so it always stopped the scan.
  ['ws control: U+0085', `<!doctype html><html><body>${CANARY}`],
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

  // Injecting must not move the doctype. Compared against the *unwrapped* document, so this is an
  // assertion about the injector: a doctype-less probe is quirks before and after, and passes.
  await load(source, `${slug}_bare`)
  const bareMode = await page.evaluate(() => document.compatMode)
  await load(wrapped, `${slug}_mode`)
  const wrappedMode = await page.evaluate(() => document.compatMode)
  const modeKept = bareMode === wrappedMode

  const ok = placement && enforced && modeKept
  if (!ok) failures += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} meta-in-head=${String(placement).padEnd(5)} inline-blocked=${String(enforced).padEnd(5)} mode=${wrappedMode}${modeKept ? '' : ` (was ${bareMode})`}`,
  )
}

await browser.close()
console.log(failures === 0 ? '\nAll probes pass.' : `\n${String(failures)} probe(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
