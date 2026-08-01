import { describe, expect, it } from 'vitest'
import {
  contractErrorSummary,
  validateSlideContract,
} from '../../../src/shared/document/slide-contract'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlideId } from '../../../src/shared/document/types'

const ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA' as SlideId

const starter = createStarterSlideHtml({ id: ID, title: 'Hello' })

/** A minimal contract-clean interactive slide: script last in body, one hover + one click hook. */
const interactiveSlide = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Chart</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0}
  .slide{width:1280px;height:720px;overflow:hidden;position:relative;padding:48px}
  .bar{font-size:20px}
</style></head>
<body>
<div class="slide">
  <div class="bar" data-hover-target data-click-target>bar</div>
</div>
<script>document.querySelector('.bar').addEventListener('mouseenter',function(){});</script>
</body></html>`

function rules(html: string, caps?: Parameters<typeof validateSlideContract>[1]): string[] {
  return validateSlideContract(html, caps)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.rule)
}

describe('validateSlideContract — Tier 1 static gate', () => {
  it('passes a clean starter slide', () => {
    const result = validateSlideContract(starter)
    expect(result.ok).toBe(true)
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    expect(contractErrorSummary(result)).toBe('slide is contract-valid')
  })

  it('passes a clean interactive slide when interactive-js is declared', () => {
    const result = validateSlideContract(interactiveSlide, ['interactive-js'])
    expect(result.ok).toBe(true)
  })

  it('SL-S01 rejects an external subresource', () => {
    const bad = starter.replace('<style>', '<link href="https://x/a.css" rel="stylesheet"><style>')
    expect(rules(bad)).toContain('SL-S01')
  })

  it('SL-S01 rejects a remote url() in CSS', () => {
    const bad = starter.replace('.title {', '.title { background: url(//evil/beacon.png);')
    expect(rules(bad)).toContain('SL-S01')
  })

  it('SL-S03 rejects @font-face', () => {
    const bad = starter.replace('<style>', '<style>\n@font-face{font-family:x;src:url(data:,)}')
    expect(rules(bad)).toContain('SL-S03')
  })

  it('SL-S04 rejects forbidden runtime APIs', () => {
    const bad = interactiveSlide.replace('addEventListener', 'fetch("/x");x.addEventListener')
    expect(rules(bad, ['interactive-js'])).toContain('SL-S04')
  })

  it('SL-S02 rejects a non-inline image source', () => {
    const bad = starter.replace('</div>', '<img src="https://x/a.png"></div>')
    expect(rules(bad)).toContain('SL-S02')
  })

  it('SL-G01 rejects wrong slide geometry', () => {
    const bad = starter.replace('width: 1280px', 'width: 1024px')
    expect(rules(bad)).toContain('SL-G01')
  })

  it('SL-G03 rejects a missing box-sizing reset', () => {
    const bad = starter.replaceAll('box-sizing: border-box;', 'box-sizing: content-box;')
    expect(rules(bad)).toContain('SL-G03')
  })

  it('SL-G05 rejects position:fixed and viewport units', () => {
    const fixed = starter.replace('.title {', '.title { position: fixed;')
    expect(rules(fixed)).toContain('SL-G05')
    const vw = starter.replace('font-size: 48px', 'font-size: 5vw')
    expect(rules(vw)).toContain('SL-G05')
  })

  it('SL-H01 rejects an undeclared <script>', () => {
    // interactive slide validated as "static" — the script is undeclared.
    expect(rules(interactiveSlide, ['static'])).toContain('SL-H01')
  })

  it('SL-I02 rejects a <script> that is not the last body element', () => {
    // Append a non-script element after the trailing <script> so it is no longer body's last child.
    const bad = interactiveSlide.replace(
      '</script>\n</body>',
      '</script>\n<div class="after"></div>\n</body>',
    )
    expect(rules(bad, ['interactive-js'])).toContain('SL-I02')
  })

  it('SL-I01 rejects an interactive slide missing a testing hook', () => {
    const bad = interactiveSlide.replace(' data-click-target', '')
    expect(rules(bad, ['interactive-js'])).toContain('SL-I01')
  })

  it('SL-A01 rejects a declared animation that is absent', () => {
    expect(rules(starter, ['css-animation'])).toContain('SL-A01')
  })

  it('SL-C01 warns on sub-16px type without blocking the write', () => {
    const small = starter.replace('font-size: 24px', 'font-size: 12px')
    const result = validateSlideContract(small)
    expect(result.ok).toBe(true)
    expect(result.issues.some((i) => i.rule === 'SL-C01' && i.severity === 'warn')).toBe(true)
  })
})
