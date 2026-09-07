import { describe, expect, it, vi } from 'vitest'

/**
 * **The spawn boundary of M3.10's enumerator.** `enumerateSystemFonts` is the one path in this
 * milestone that starts a process, and every hardening measure on it — the allow-listed child
 * environment, `-NoProfile`/`-NonInteractive`, `windowsHide`, `timeout`, `maxBuffer` — was
 * deletable with lint, typecheck and the whole suite green until this file existed (M3.10 review
 * r13: seeding `childEnv` from `{ ...source }` handed `powershell.exe` the entire main-process
 * environment and nothing anywhere went red).
 *
 * Modelled on `tests/unit/agent/auth-env.test.ts`, which is the pattern this module's own comment
 * says it follows: build the child environment by **adding to nothing**, then prove it against a
 * source seeded with credentials. The argv/options half is asserted through a faked `execFile`,
 * because the options object is where four of the six measures live and a unit test cannot observe
 * them any other way — the real enumerator is exercised in `enumerate.test.ts`.
 */

/** Names a real main process carries that must never reach a font enumerator. */
const HOSTILE = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'SSH_AUTH_SOCK',
  'NODE_OPTIONS',
  'PSModulePath',
  'HTTP_PROXY',
] as const

/** A plausible win32 environment: everything the allow-list wants, plus everything it must drop. */
function hostileSourceEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    SystemDrive: 'C:',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATH: 'C:\\Windows\\system32',
    PATHEXT: '.COM;.EXE;.BAT',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    ProgramFiles: 'C:\\Program Files',
    ProgramData: 'C:\\ProgramData',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    USERPROFILE: 'C:\\Users\\u',
  }
  for (const name of HOSTILE) base[name] = 'hostile-value'
  return base
}

/**
 * A callback-shaped stand-in for `node:child_process`'s `execFile`, recording what it was asked to
 * run. `promisify` has no `util.promisify.custom` to find on it, so it resolves with whatever the
 * callback's second argument is — hence the `{ stdout, stderr }` shape the module destructures.
 */
const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = []

/**
 * What each tool "prints", shaped so the branch's **parser** is observable and not just its argv.
 *
 * `fc-list : family` puts a font's aliases on one comma-separated line, which is the whole reason
 * `parseFcListOutput` exists; PowerShell prints one name per line and never a comma. A stub with no
 * comma in it makes the two parsers agree, so the linux branch could call the wrong one unnoticed
 * (M3.10 review r15 — the real host loses 5 of its 12 families that way).
 */
const STUB_STDOUT: Readonly<Record<string, string>> = {
  'powershell.exe': 'Arial\nGeorgia\n',
  'fc-list': 'Arial\nGeorgia,Georgia Pro\n',
}

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
    callback: (error: null, value: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push({ file, args, options })
    callback(null, { stdout: STUB_STDOUT[file] ?? '', stderr: '' })
  },
}))

const { childEnv, WINDOWS_ENV_ALLOW, enumerateSystemFonts } =
  await import('../../../src/main/fonts/enumerate')

describe('the font enumerator’s child environment', () => {
  it('sanity: the fixture really does seed every hostile name', () => {
    const source = hostileSourceEnv()
    for (const name of HOSTILE) expect(source[name]).toBe('hostile-value')
  })

  /**
   * The allow-list itself, written out — because every other assertion here compares the child's
   * keys *against* `WINDOWS_ENV_ALLOW`, and a change to the constant moves both sides at once.
   * Dropping `PATH` or `ProgramFiles` from it was green until this line existed (r15). The
   * uncaught direction is the safe one — a shorter list leaks less — but "leaks less" and "starts
   * at all" are different properties, and this is the one that says which names the spawn depends
   * on. Adding a name is the direction that matters and reds here too.
   */
  it('is exactly the names powershell.exe needs to start and load System.Drawing', () => {
    expect([...WINDOWS_ENV_ALLOW]).toEqual([
      'SystemRoot',
      'windir',
      'SystemDrive',
      'ComSpec',
      'PATH',
      'PATHEXT',
      'TEMP',
      'TMP',
      'ProgramFiles',
      'ProgramData',
      'LOCALAPPDATA',
      'APPDATA',
      'USERPROFILE',
    ])
  })

  /**
   * THE test. The child gets the allow-list and nothing else — including names no list mentions,
   * which is what makes it total. Reds on `{ ...source }` as the seed, the r13 mutation.
   */
  it('admits ONLY the allow-listed names, whatever the parent carries', () => {
    const env = childEnv(hostileSourceEnv())

    expect(Object.keys(env).toSorted()).toEqual([...WINDOWS_ENV_ALLOW].toSorted())
    for (const name of HOSTILE) expect(name in env).toBe(false)
  })

  it('omits an allow-listed name the parent does not have, rather than setting it undefined', () => {
    // `env: { PATH: undefined }` is not the same child as `env: {}` for every spawn path, and an
    // `undefined` value would also make the key-set assertion above pass on a scrub that did not
    // actually filter.
    const env = childEnv({ SystemRoot: 'C:\\Windows' })

    expect(Object.keys(env)).toEqual(['SystemRoot'])
  })

  it('copies the values through unchanged', () => {
    expect(childEnv(hostileSourceEnv())['USERPROFILE']).toBe('C:\\Users\\u')
  })
})

describe('the font enumerator’s spawn options', () => {
  it('runs powershell.exe with a scrubbed env, no profile, hidden, capped and timed out', async () => {
    calls.length = 0

    const result = await enumerateSystemFonts('win32')
    expect(result.source).toBe('powershell')
    expect(result.families).toEqual(['Arial', 'Georgia'])

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.file).toBe('powershell.exe')

    // `-NoProfile` keeps a user's `$PROFILE` script out of the process; `-NonInteractive` means a
    // prompt fails rather than hanging the enumeration; `-EncodedCommand` is why the script cannot
    // be re-parsed by the shell.
    expect(call.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(call.args).toHaveLength(4)

    // The payload, which is the half that does the work. Both the transport and the script are
    // written out here as literals rather than imported from the module: decoding with the same
    // constant the module encodes with would pin nothing, since a mutation moves both sides.
    //
    // `-EncodedCommand` takes **UTF-16LE** base64 and nothing else. Encoding the script as UTF-8
    // instead is silent everywhere on this side — lint, types and the whole suite stay green — and
    // total in production: real `powershell.exe` answers `Command failed`, the enumerator's own
    // catch turns that into `{ families: [], source: 'none' }`, and every Windows user gets the
    // system-only group with the milestone's feature simply gone (M3.10 review r14). Decoding a
    // UTF-8 payload as UTF-16LE yields mojibake, so this reds.
    // Standard base64, not `base64url`. `Buffer.from(x, 'base64')` decodes both alphabets and
    // tolerates missing padding, so decoding first and comparing the script would accept a
    // `base64url` payload — which `powershell.exe` does not: it starts, prints its own usage text,
    // and the enumerator hands 35 fragments of English prose to the dropdown, every one of which
    // passes `isValidFontFamilyName` and reaches slide CSS (r15, measured: 515 families pristine,
    // 35 mutated). Worse than a broken spawn, because the child *succeeds*. So the assertion is on
    // the wire bytes, built here from the test's own literals.
    const script = Buffer.from(call.args[3]!, 'base64').toString('utf16le')

    // The module's own stated headline subtlety, and the one failure with no error anywhere:
    // without it PowerShell writes the pipe in the console's OEM code page, a fifth of a stock
    // Windows 11 family list is CJK or fullwidth, and the symptom is "the Japanese fonts are
    // missing". Unpinnable behaviourally on a host with no non-ASCII family names, which is every
    // host this suite runs on.
    expect(script).toContain('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8')

    // Subsumes a `toBe` on the decoded script — it pins the payload *and* the transport — and is
    // built from literals, so a change to `POWERSHELL_SCRIPT` cannot move both sides.
    const EXPECTED_SCRIPT =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
      'Add-Type -AssemblyName System.Drawing;' +
      '(New-Object System.Drawing.Text.InstalledFontCollection).Families|ForEach-Object{$_.Name}'
    expect(call.args[3]).toBe(Buffer.from(EXPECTED_SCRIPT, 'utf16le').toString('base64'))

    expect(call.options['windowsHide']).toBe(true)
    // Without this the child's stdout arrives as a Buffer and the parser's `.split('\n')` throws
    // into the catch — the same silent zero-families outcome as a bad payload.
    expect(call.options['encoding']).toBe('utf8')
    expect(call.options['timeout']).toBe(10_000)
    expect(call.options['maxBuffer']).toBe(4 * 1024 * 1024)

    // The env the child actually receives, not the one `childEnv` would build in isolation.
    const env = call.options['env'] as NodeJS.ProcessEnv
    for (const name of Object.keys(env)) {
      expect(WINDOWS_ENV_ALLOW as readonly string[]).toContain(name)
    }
    for (const name of HOSTILE) expect(name in env).toBe(false)
  })

  it('caps and times out the linux enumerator too', async () => {
    calls.length = 0

    const result = await enumerateSystemFonts('linux')
    expect(result.source).toBe('fc-list')
    // Which parser the branch calls, not just which binary it spawns. `fc-list : family` puts a
    // font's aliases on one comma-separated line; run through the PowerShell parser instead, the
    // whole line is one name, `normalizeFontFamilies` rejects it, and the aliases are gone — 5 of
    // this host's 12 real families (r15). The comma in the stub is what makes the two parsers
    // disagree, and so is load-bearing.
    expect(result.families).toEqual(['Arial', 'Georgia', 'Georgia Pro'])

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.file).toBe('fc-list')
    // `: family` is the format argument that makes fc-list print family names; `: file` prints
    // paths, which `normalizeFontFamilies` then refuses wholesale for an empty dropdown and no
    // error. Nothing else calls this branch on the real path, so the argv is pinned here or nowhere.
    expect(call.args).toEqual([':', 'family'])
    expect(call.options['timeout']).toBe(10_000)
    expect(call.options['maxBuffer']).toBe(4 * 1024 * 1024)
    expect(call.options['encoding']).toBe('utf8')
  })

  it('spawns nothing at all on a platform with no enumerator', async () => {
    calls.length = 0

    expect(await enumerateSystemFonts('darwin')).toEqual({ families: [], source: 'none' })
    expect(calls).toEqual([])
  })
})
