// Renders a slide HTML file and captures evidence for adversarial review.
// Usage: node render.mjs <slide.html> <outdir> [--interactive]
// Outputs into <outdir>: t0.png, t2.png, t5.png, hover.png*, click.png*, console.log, report.json
// * only with --interactive, using [data-hover-target] / [data-click-target] hooks.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const [file, outdir, flag] = process.argv.slice(2);
const interactive = flag === '--interactive';
mkdirSync(outdir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleLines = [];
page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

await page.goto('file://' + resolve(file));
await page.waitForTimeout(300);
await page.screenshot({ path: `${outdir}/t0.png` });
await page.waitForTimeout(2000);
await page.screenshot({ path: `${outdir}/t2.png` });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${outdir}/t5.png` });

const report = { file, interactive, overflow: null, hover: null, click: null };
report.overflow = await page.evaluate(() => {
  const d = document.documentElement;
  return { scrollW: d.scrollWidth, scrollH: d.scrollHeight, overflows: d.scrollWidth > 1280 || d.scrollHeight > 720 };
});

if (interactive) {
  const hoverEl = page.locator('[data-hover-target]').first();
  if (await hoverEl.count()) {
    await hoverEl.hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outdir}/hover.png` });
    report.hover = 'captured';
  } else report.hover = 'NO [data-hover-target] FOUND';

  const clickEl = page.locator('[data-click-target]').first();
  if (await clickEl.count()) {
    await clickEl.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outdir}/click.png` });
    report.click = 'captured';
  } else report.click = 'NO [data-click-target] FOUND';
}

writeFileSync(`${outdir}/console.log`, consoleLines.join('\n') || '(no console output)');
writeFileSync(`${outdir}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify(report));
