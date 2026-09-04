/**
 * Enumerating the machine's installed font families (M3.10).
 *
 * ## Why main, and not `queryLocalFonts` in the renderer
 *
 * Chromium exposes the Local Font Access API, which would have kept this out of the main process
 * entirely. It was rejected on three counts, in order of weight:
 *
 *  1. **It prompts.** `queryLocalFonts()` is permission-gated (`local-fonts`). Electron has no
 *     default grant, so today the call would simply be denied; making it work means adding the
 *     app's first `setPermissionRequestHandler` and auto-granting — at which point the "permission"
 *     is theatre, and the milestone's requirement is explicitly "works on Windows without a prompt".
 *  2. **It needs a user gesture.** The API requires transient activation, so the font list cannot be
 *     warmed before the user opens the dropdown; the first open would always pay the full cost.
 *  3. **It is unavailable on Linux**, which is where this app is developed.
 *
 * Enumerating in main and handing the renderer a validated list also matches how the rest of this
 * codebase splits privilege: main owns the capability, the renderer receives a checked value.
 *
 * ## What actually runs, and the evidence for it
 *
 * - **win32** — Windows PowerShell + GDI+ `InstalledFontCollection`. This is the same mechanism the
 *   `font-list` npm package uses on Windows; it is inlined here rather than taking the dependency,
 *   because the package is a thin `exec` wrapper whose Windows branch is the three lines below and
 *   whose output handling does not address the encoding problem in the next paragraph.
 * - **linux** — `fc-list`. Verified on the dev host: present at `/usr/bin/fc-list`, returns 12
 *   families. Note that under WSL those are the *Linux* families (DejaVu, Ubuntu) — WSL cannot see
 *   the Windows host's fonts, so a WSL run is not a preview of what a Windows user gets.
 * - **anything else** — no enumeration. The dropdown still offers the system group, which is the
 *   only group that survives export anyway.
 *
 * **Encoding is the subtle part.** A fifth of the family names on a stock Windows 11 machine are
 * CJK or fullwidth (`ＭＳ Ｐゴシック`, `맑은 고딕`), and PowerShell writes stdout in the console's OEM
 * code page by default, which mangles all of them into bytes the allow-list then rejects — the
 * failure mode is "the Japanese fonts are missing", with no error anywhere. Hence the explicit
 * `[Console]::OutputEncoding` assignment, and hence reading the pipe as UTF-8.
 *
 * The script is passed via `-EncodedCommand` (base64 UTF-16LE). Nothing renderer-supplied reaches
 * the command line — the request carries no payload at all — so this is not defusing untrusted
 * input; it removes a whole class of quoting bugs between Node's Windows argv escaping and
 * PowerShell's own parser, which is worth it for a string containing `$_`, `{}` and `::`.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { normalizeFontFamilies } from '../../shared/fonts/family'

const execFileAsync = promisify(execFile)

/** Where a font list came from. Reported so a failure is distinguishable from a bare machine. */
export type FontSource = 'powershell' | 'fc-list' | 'none'

export interface EnumeratedFonts {
  readonly families: readonly string[]
  readonly source: FontSource
}

/** Enumeration is a cold-start cost, not a hang: past this the list is simply empty for the session. */
const ENUMERATE_TIMEOUT_MS = 10_000

/** ~341 names on a stock Windows host; 4 MB is far more than any real machine produces. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * The PowerShell script, in readable form. Kept as a constant so what gets base64'd below is
 * reviewable; it is a compile-time literal and interpolates nothing.
 */
const POWERSHELL_SCRIPT = [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Drawing',
  '(New-Object System.Drawing.Text.InstalledFontCollection).Families|ForEach-Object{$_.Name}',
].join(';')

/**
 * The child's environment, built by **adding to nothing** rather than subtracting from
 * `process.env` — the discipline `src/main/agent/auth-env.ts` established for the agent subprocess.
 * These are the variables without which `powershell.exe` does not start or cannot load assemblies;
 * nothing about the user's shell, network or credentials is inherited.
 */
const WINDOWS_ENV_ALLOW = [
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
] as const

function childEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of WINDOWS_ENV_ALLOW) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * `fc-list : family` prints one line per font file, and a line may carry a font's aliases as a
 * comma-separated list (`DejaVu Sans,DejaVu Sans Light`). Both halves are real family names, so the
 * line is split rather than taken whole.
 */
export function parseFcListOutput(stdout: string): string[] {
  return normalizeFontFamilies(stdout.split('\n').flatMap((line) => line.split(',')))
}

/** PowerShell prints one family name per line. */
export function parsePowerShellOutput(stdout: string): string[] {
  return normalizeFontFamilies(stdout.split('\n'))
}

/**
 * Run the platform's enumerator. Resolves to an empty list rather than rejecting when the tool is
 * missing, times out or fails: a machine whose fonts we cannot list is a machine that gets the
 * system group, not a broken property panel.
 */
export async function enumerateSystemFonts(
  platform: NodeJS.Platform = process.platform,
): Promise<EnumeratedFonts> {
  try {
    if (platform === 'win32') {
      const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64')
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        {
          timeout: ENUMERATE_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: 'utf8',
          env: childEnv(process.env),
        },
      )
      return { families: parsePowerShellOutput(stdout), source: 'powershell' }
    }

    if (platform === 'linux') {
      const { stdout } = await execFileAsync('fc-list', [':', 'family'], {
        timeout: ENUMERATE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      })
      return { families: parseFcListOutput(stdout), source: 'fc-list' }
    }

    return { families: [], source: 'none' }
  } catch (error) {
    // Degrading to "no installed fonts" is right; degrading silently is not. On the Windows host
    // this feature exists for, a blocked or timed-out PowerShell would otherwise leave nothing
    // anywhere to explain the empty dropdown.
    // eslint-disable-next-line no-console -- main's diagnostic channel; see src/main/agent/log.ts
    console.warn('[fonts] enumeration failed', error)
    return { families: [], source: 'none' }
  }
}
