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

  describe('SL-S01 external-subresource vectors (parse5 tree, hostile input)', () => {
    // Each vector is injected inside the slide body and must be rejected by SL-S01.
    const inject = (markup: string): string => starter.replace('</div>', `${markup}</div>`)

    it.each([
      ['iframe src', '<iframe src="https://evil/x"></iframe>'],
      ['video src', '<video src="//evil/v.mp4"></video>'],
      ['audio src', '<audio src="http://evil/a.mp3"></audio>'],
      ['source src', '<video><source src="https://evil/v.webm"></video>'],
      ['object data', '<object data="https://evil/o.svg"></object>'],
      ['embed src', '<embed src="https://evil/e.swf">'],
      ['track src', '<video><track src="https://evil/c.vtt"></video>'],
      ['img srcset', '<img srcset="https://evil/a.png 1x, //evil/b.png 2x">'],
      ['relative src is off-document', '<iframe src="local.html"></iframe>'],
      // Attribute-order / case / whitespace tricks a regex might miss — parse5 normalizes them.
      ['uppercase + reordered attrs', '<IFRAME title="t"  SRC = "https://evil/x"></IFRAME>'],
    ])('SL-S01 rejects %s', (_label, markup) => {
      expect(rules(inject(markup))).toContain('SL-S01')
    })

    it('SL-S01 rejects a <link> of any rel with a remote href', () => {
      const bad = starter.replace(
        '<style>',
        '<link rel="preload" href="https://evil/x.css"><style>',
      )
      expect(rules(bad)).toContain('SL-S01')
    })

    it('SL-S01 rejects an external SVG <use>', () => {
      const bad = inject('<svg><use href="https://evil/sprite.svg#i"></use></svg>')
      expect(rules(bad)).toContain('SL-S01')
    })

    it.each([
      ['input[type=image] src', '<input type="image" src="https://evil/btn.png">'],
      ['video poster', '<video poster="https://evil/p.jpg"></video>'],
      ['link imagesrcset', '<link rel="preload" as="image" imagesrcset="https://evil/a.png 1x">'],
      ['legacy background=', '<table background="https://evil/bg.png"><tr><td>x</td></tr></table>'],
    ])('SL-S01 rejects %s', (_label, markup) => {
      expect(rules(inject(markup))).toContain('SL-S01')
    })

    // The MINOR-1 false-positive: a data: URI contains commas and srcset is comma-separated.
    it('SL-S01 allows a srcset whose candidate is a comma-bearing data: URI', () => {
      const plain = inject('<img srcset="data:image/svg+xml,%3Csvg%3E%3C/svg%3E 1x">')
      expect(rules(plain)).not.toContain('SL-S01')
      const base64 = inject(
        '<img srcset="data:image/png;base64,iVBORw0KGgoAAAA= 1x, data:image/png;base64,BBBB 2x">',
      )
      expect(rules(base64)).not.toContain('SL-S01')
      expect(validateSlideContract(base64).ok).toBe(true)
    })

    it('SL-S01 rejects only the external candidate when a srcset mixes data: and http:', () => {
      const mixed = inject('<img srcset="data:image/png;base64,AAAA 1x, https://evil/b.png 2x">')
      expect(rules(mixed)).toContain('SL-S01')
    })

    it('SL-S01 allows a link imagesrcset of data: candidates', () => {
      const ok = starter.replace(
        '<style>',
        '<link rel="preload" as="image" imagesrcset="data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x"><style>',
      )
      expect(rules(ok)).not.toContain('SL-S01')
    })

    it('SL-S01 allows inline/local controls (data:, blob:, sloodge-asset:, # fragment)', () => {
      const ok = inject(
        '<img src="data:image/png;base64,AAAA">' +
          '<video src="blob:abc"></video>' +
          '<svg><use href="#gradient"></use></svg>',
      )
      expect(rules(ok)).not.toContain('SL-S01')
      expect(validateSlideContract(ok).ok).toBe(true)
    })
  })

  it('SL-G05 rejects position:fixed and viewport units in an INLINE style attribute', () => {
    const fixed = starter.replace('<div class="slide"', '<div style="position:fixed" class="slide"')
    expect(rules(fixed)).toContain('SL-G05')
    const vmax = starter.replace('<h1', '<h1 style="width:50vmax"')
    expect(rules(vmax)).toContain('SL-G05')
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
