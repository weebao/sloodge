/**
 * Does a `blob:` iframe inherit the embedder's CSP?
 *
 * M1.3 switched slide delivery from `srcdoc` to blob URLs (10-architecture.md §7) partly on the
 * belief that a blob-loaded frame gets a fresh policy rather than an inherited one, which would
 * unblock the slide contract's `interactive-js` capability under the host page's `script-src 'self'`.
 *
 * This settles it. Run (from this directory, once `npm install` has provided playwright):
 *
 *     cd experiments/init/harness && npm install && node csp-blob-inheritance.mjs
 *
 * Measured 2026-07-31, Chromium via Playwright 1.62:
 *
 *     RESULT: NO-MESSAGE (inline blocked or frame failed)
 *     console: "Executing inline script violates the following Content Security Policy directive
 *               'script-src 'self''. … The action has been blocked."
 *     SRCDOC CONTROL: NO-MESSAGE
 *
 * **The premise is false: blob frames inherit the embedder CSP, exactly like `srcdoc`.** Per HTML's
 * "determine navigation params policy container", a navigation whose response URL is a *local*
 * scheme — Fetch defines those as `about`, `blob` and `data` — inherits a clone of the initiator's
 * policy container, CSP list included. Escaping inheritance needs a non-local scheme, i.e. the
 * `slide://` custom protocol registered with `protocol.handle` in the main process (80-roadmap.md,
 * M2 prerequisite).
 */
import { chromium } from 'playwright'

const HOST_HTML = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; frame-src blob:; style-src 'unsafe-inline'">
</head><body><div id="x"></div></body></html>`

/** Appends a sandboxed frame carrying an inline script and reports whether the script ran. */
function probe(deliver) {
  return new Function(
    'deliver',
    `return (async () => {
      const slide = '<!doctype html><html><head></head><body><scr' + 'ipt>parent.postMessage("inline-ran","*")</scr' + 'ipt></body></html>'
      const got = new Promise((res) => {
        const t = setTimeout(() => res('NO-MESSAGE (inline blocked or frame failed)'), 3000)
        addEventListener('message', (e) => { clearTimeout(t); res('MESSAGE: ' + e.data) })
      })
      const f = document.createElement('iframe')
      f.sandbox = 'allow-scripts'
      if (deliver === 'blob') f.src = URL.createObjectURL(new Blob([slide], { type: 'text/html' }))
      else f.srcdoc = slide
      document.body.appendChild(f)
      return got
    })()`,
  )(deliver)
}

const browser = await chromium.launch()
const page = await browser.newPage()
const logs = []
page.on('console', (message) => logs.push(message.text()))
await page.route('http://host.test/', (route) =>
  route.fulfill({ contentType: 'text/html', body: HOST_HTML }),
)
await page.goto('http://host.test/')

console.log('BLOB:  ', await page.evaluate(probe, 'blob'))
console.log('SRCDOC:', await page.evaluate(probe, 'srcdoc'))
console.log('console:', JSON.stringify(logs.slice(0, 4), null, 2))

await browser.close()
