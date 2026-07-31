import { describe, expect, it } from 'vitest'
import { isAllowedNavigation, toSafeExternalUrl } from '../../src/main/security/externalUrls'

describe('toSafeExternalUrl', () => {
  it.each(['https://example.com/a?b=c', 'http://localhost:5173/', 'mailto:a@b.co'])(
    'allows %s',
    (url) => {
      expect(toSafeExternalUrl(url)).not.toBeNull()
    },
  )

  it.each([
    'file:///etc/passwd',
    'smb://attacker/share',
    'javascript:alert(1)',
    'chrome://settings',
    'vscode://malicious/payload',
    'ftp://example.com/x',
    'about:blank',
    'data:text/html,<script>1</script>',
    'blob:https://example.com/uuid',
  ])('drops %s', (url) => {
    expect(toSafeExternalUrl(url)).toBeNull()
  })

  it('drops strings that do not parse as URLs at all', () => {
    expect(toSafeExternalUrl('not a url')).toBeNull()
    expect(toSafeExternalUrl('')).toBeNull()
    expect(toSafeExternalUrl('//example.com/protocol-relative')).toBeNull()
  })

  it('is not fooled by scheme-lookalike prefixes', () => {
    // The scheme is what the parser says it is, not what the string starts with.
    expect(toSafeExternalUrl('https:alert(1)')).not.toBeNull() // parses as https:
    expect(toSafeExternalUrl(' javascript:alert(1)')).toBeNull()
    expect(toSafeExternalUrl('HTTPS://example.com')).not.toBeNull() // schemes are case-insensitive
  })

  it('returns the parsed href, not the raw string it validated', () => {
    // Check-then-use across two parsers leaks: an embedded tab is stripped by
    // the URL parser, so the validated bytes must be the forwarded bytes.
    expect(toSafeExternalUrl('ht\ttps://example.com/')).toBe('https://example.com/')
    expect(toSafeExternalUrl('HTTPS://EXAMPLE.com/Path')).toBe('https://example.com/Path')
  })
})

describe('isAllowedNavigation', () => {
  describe('dev (http app URL)', () => {
    const dev = 'http://localhost:5173/'

    it('allows a dev-server full reload to its own origin', () => {
      expect(isAllowedNavigation('http://localhost:5173/', dev)).toBe(true)
      expect(isAllowedNavigation('http://localhost:5173/index.html', dev)).toBe(true)
    })

    it('blocks cross-origin targets even in dev', () => {
      expect(isAllowedNavigation('http://localhost:9999/', dev)).toBe(false)
      expect(isAllowedNavigation('https://localhost:5173/', dev)).toBe(false) // scheme differs
      expect(isAllowedNavigation('http://evil.example/', dev)).toBe(false)
      expect(isAllowedNavigation('file:///etc/passwd', dev)).toBe(false)
    })

    it('blocks blob: URLs even though their origin getter matches the minting origin', () => {
      expect(isAllowedNavigation('blob:http://localhost:5173/some-uuid', dev)).toBe(false)
    })
  })

  describe('production (file: app URL)', () => {
    const prod = 'file:///opt/sloodge/resources/renderer/index.html'

    it('allows reloading exactly the shipped document', () => {
      expect(isAllowedNavigation(prod, prod)).toBe(true)
      // location.reload() preserves query/hash; the pathname is what must match.
      expect(isAllowedNavigation(`${prod}?x=1#top`, prod)).toBe(true)
    })

    it('blocks every other file: target', () => {
      expect(isAllowedNavigation('file:///etc/passwd', prod)).toBe(false)
      expect(isAllowedNavigation('file:///opt/sloodge/resources/renderer/other.html', prod)).toBe(
        false,
      )
    })

    it('blocks a UNC host serving the same pathname', () => {
      // On Windows, file://host/path is an SMB share — same pathname,
      // attacker-controlled bytes. The host must match the shipped document's.
      expect(
        isAllowedNavigation('file://evil.example/opt/sloodge/resources/renderer/index.html', prod),
      ).toBe(false)
    })

    it('blocks non-file schemes outright', () => {
      expect(isAllowedNavigation('http://localhost:5173/', prod)).toBe(false)
      expect(isAllowedNavigation('https://example.com/', prod)).toBe(false)
    })
  })

  it('blocks everything when no app URL is known', () => {
    expect(isAllowedNavigation('http://localhost:5173/', undefined)).toBe(false)
    expect(isAllowedNavigation('https://example.com/', '')).toBe(false)
  })

  it('never matches two file: documents through their opaque "null" origins', () => {
    expect(isAllowedNavigation('file:///a.html', 'file:///b.html')).toBe(false)
  })

  it('blocks when either side fails to parse', () => {
    expect(isAllowedNavigation('not a url', 'http://localhost:5173/')).toBe(false)
    expect(isAllowedNavigation('http://localhost:5173/', 'not a url')).toBe(false)
  })
})
