/**
 * The adversarial slide corpus both Design Mode source-map suites run against.
 *
 * Slide HTML is model-generated and treated as hostile, so the properties in these suites are
 * asserted over a shared set of shapes rather than over one happy-path document. Several entries
 * are lifted from `tests/unit/canvas/wrap-slide-html.test.ts`, whose corpus was built by five
 * rounds of review hunting for inputs where an offset-based transform anchors somewhere the tree
 * builder does not honour — exactly the failure class a span map has to survive.
 */

import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'

export interface CorpusEntry {
  name: string
  html: string
}

export const CORPUS: readonly CorpusEntry[] = [
  // A real generated slide: doctype, head, style block, nested divs, entities.
  {
    name: 'starter slide',
    html: createStarterSlideHtml({
      id: 's_01H8XQZ4P7K2M9NB3VYRTC6FDA',
      title: 'Q3 Revenue',
      subtitle: '<b> & "x"',
    }),
  },

  // Document shapes.
  { name: 'full document', html: '<!doctype html><html><head></head><body><p>x</p></body></html>' },
  { name: 'no doctype', html: '<html>no doctype</html>' },
  { name: 'bare fragment', html: '<p>fragment</p>' },
  { name: 'body only', html: '<body><p>x</p>' },
  { name: 'end tags only', html: '<p>x</p></body></html>' },
  { name: 'leading comment then doctype', html: '<!-- c --><!doctype html><html><p>x</p>' },
  { name: 'byte order mark', html: '﻿<p>x</p>' },

  // Prologue forms the tokenizer turns into bogus comments or discards outright.
  { name: 'abrupt comment', html: '<!--><!doctype html><html><p>x</p>' },
  { name: 'bogus declaration', html: '<!foo><div>x</div>' },
  { name: 'xml declaration', html: '<?xml version="1.0"?><div>x</div>' },
  { name: 'empty end tag', html: '</><div>x</div>' },
  { name: 'comment closed with --!>', html: '<!-- c --!><div>x</div>' },

  // Encoding.
  { name: 'astral plane', html: '<p>😀 bars 🎯</p><b>x</b>' },
  { name: 'multi-byte utf-8', html: '<p>Café 中文 — dash</p><b>x</b>' },
  { name: 'crlf line endings', html: '<div>\r\n  <p>a\r\nb</p>\r\n</div>\r\n' },
  { name: 'lone cr', html: '<p>a\rb</p><b>y</b>' },
  { name: 'astral inside an attribute', html: '<div title="😀" class="c">x</div>' },

  // Entities.
  { name: 'entities in text and attribute', html: '<p title="a&amp;b">x&lt;y &#8212; z</p>' },
  // A character reference ends in `;`, which is also what ends a CSS declaration — the M3.18
  // collision. Three spellings of the same quote plus the ambiguous-ampersand form, which is the
  // one the tokenizer must *not* decode.
  {
    name: 'entity-quoted family in a style attribute',
    html: '<p style="font-family: &quot;Georgia&quot;, serif; color: red">x</p>',
  },
  {
    name: 'numeric and hex references in a style attribute',
    html: '<p style="font-family: &#34;A&#34;; color: &#x23;abc">x</p>',
  },
  {
    name: 'ambiguous ampersand in an attribute',
    html: '<div style="font-family: &quotGeorgia, serif" title="a&quot,b">x</div>',
  },

  // Attribute shapes.
  { name: 'duplicate attributes', html: '<div a="1" a="2" class="c">x</div>' },
  { name: 'unquoted and valueless', html: '<div class=title data-x hidden>t</div>' },
  { name: 'single quotes holding a double quote', html: `<div title='a"b'>x</div>` },
  { name: 'whitespace around equals', html: '<div class = "a" id ="b">x</div>' },
  { name: 'multiline start tag', html: '<div\n  class="a"\n  id="b"\n>x</div>' },
  { name: 'uppercase tag and attributes', html: '<DIV CLASS="c" DATA-X="1">x</DIV>' },
  { name: 'equals-prefixed attribute name', html: '<div =a class="c">x</div>' },
  { name: 'empty attribute value', html: '<div class="">x</div>' },

  // Structure.
  { name: 'nested identical elements', html: '<div><div><div>a</div></div></div>' },
  {
    name: 'repeated identical siblings',
    html: '<svg><g><rect x="1"/><rect x="1"/><rect x="1"/></g></svg>',
  },
  { name: 'implied end tags', html: '<ul><li>a<li>b</ul>' },
  { name: 'empty implied-end li', html: '<ul><li></ul>' },
  { name: 'unclosed at eof', html: '<div><span>x' },
  { name: 'void elements', html: '<img src="x"><br><hr/><p>after</p>' },
  { name: 'empty element', html: '<div></div>' },
  { name: 'comment between children', html: '<div><!-- c --><b>x</b></div>' },
  { name: 'mixed inline content', html: '<p>Revenue rose <b>18%</b> in Q3</p>' },
  {
    name: 'foster parented table content',
    html: '<table><div>fostered</div><tr><td>c</td></tr></table>',
  },

  // Mis-nested formatting: the adoption agency CLONES the formatting element, and parse5 copies
  // the original's sourceCodeLocation onto the clone — so one physical start tag backs several
  // tree elements. Ordinary output from a model writing slide HTML, and the shape that falsified
  // an earlier fixpoint claim (one extra data-sl-id per round-trip, unbounded).
  { name: 'mis-nested formatting', html: '<p><b>bold<i>both</p><p>italic</i></p>' },
  { name: 'mis-nested across paragraphs', html: '<p><strong>a</p><p>b</strong></p>' },
  { name: 'mis-nested bold', html: '<p><b>x</p><p>y</b></p>' },
  { name: 'mis-nested anchor with attributes', html: '<p><a href="#">x</p><p>y</a></p>' },
  {
    name: 'mis-nested realistic slide',
    html: '<div class="slide"><p><strong>Q3 <em>revenue</em></p><p>rose</strong></em></p></div>',
  },
  { name: 'mis-nested three deep', html: '<p><b><i><u>x</p><p>y</u></i></b></p>' },
  { name: 'mis-nested formatting wrapping a block', html: '<b><p>x</b>y</p>' },
  {
    name: 'mis-nested with a fresh element inside the clone',
    html: '<p><b>x</p><p>y<span>s</span></b></p>',
  },

  // Foreign content.
  {
    name: 'svg with camelCase attributes',
    html: '<svg viewBox="0 0 640 360" gradientUnits="userSpaceOnUse"><rect x="1" y="2"/></svg>',
  },
  { name: 'nested svg', html: '<svg><svg><rect/></svg></svg>' },
  // `xmlns` is the one entry in parse5's XML attribute adjustment table with an EMPTY-STRING
  // prefix, so a reconciliation rule that only rejects `undefined` mis-keys it as `':xmlns'`, the
  // decode is never found and `AttrSpan.text` falls back to raw bytes. The entity is what makes
  // that visible; `xmlns` on `<svg>` is otherwise standard boilerplate. Both `slide-map.test.ts`'s
  // zero-miss walk and its decodes table depend on this entry.
  {
    name: 'svg xmlns with an entity in its value',
    html: '<svg xmlns="http://example.com/a&amp;b" viewBox="0 0 1 1"><rect/></svg>',
  },
  // The other half of the same rejoin rule. `xmlns` exercises the empty-prefix branch; nothing
  // exercised the NON-empty one, so review r2 found that dropping the prefix entirely
  // (`const key = attr.name`) left the zero-miss walk green — a guard covering half its subject.
  // parse5 maps this to `{ prefix: 'xlink', name: 'href' }`, keyed `xlink:href` in the locations.
  {
    name: 'svg xlink:href with an entity in its value',
    html: '<svg><use xlink:href="#a&amp;b" x="1"/></svg>',
  },
  {
    name: 'foreignObject re-entering html',
    html: '<svg><foreignObject><div>h</div></foreignObject></svg>',
  },
  { name: 'mathml', html: '<math><mi>x</mi></math>' },
  { name: 'svg self-closed and unclosed', html: '<svg><rect/><circle></svg>' },
  // The `/` here belongs to the UNQUOTED attribute value `a/`, not to a self-closing solidus.
  { name: 'svg unquoted value ending in a solidus', html: '<svg><image href=a/></svg>' },
  { name: 'svg quoted value ending in a solidus', html: '<svg><image href="a/"/></svg>' },

  // Template.
  { name: 'template content', html: '<template><i>y</i><b>z</b></template>' },
  {
    name: 'nested template',
    html: '<template><div><template><p>deep</p></template></div></template>',
  },

  // Raw text that must not be mistaken for markup.
  { name: 'script holding markup', html: '<script>var a = "<div>";</script><p>y</p>' },
  { name: 'style holding braces', html: '<style>.a{content:"<b>"}</style><p>y</p>' },

  // Already carrying ids.
  {
    name: 'authored data-sl-id',
    html: '<div data-sl-id="e_0f3"><p data-sl-id="e_0f4">x</p></div>',
  },
  { name: 'uppercase authored data-sl-id', html: '<div DATA-SL-ID="e_0f3">x</div>' },
  { name: 'valueless data-sl-id', html: '<div data-sl-id>x</div>' },
]

/** A slide id shaped like the real ones, distinctive enough to grep out of instrumented output. */
export const SLIDE_ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'
