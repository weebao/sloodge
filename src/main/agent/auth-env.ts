/**
 * Building the agent subprocess's environment (M2.7).
 *
 * ## Why this is an allow-list
 *
 * Three review rounds found three separate hijack layers in the same shape, each one a variable we
 * had not thought to delete:
 *
 *   1. **Credential** — `ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN`, so an ambient key
 *      silently outranked the token the user pasted in Settings.
 *   2. **Provider** — `getAPIProvider()` is env-only and runs *before* credential logic; under
 *      `CLAUDE_CODE_USE_BEDROCK=1` the OAuth path is forced off entirely and the Bedrock branch nulls
 *      `Authorization` and authenticates with AWS instead.
 *   3. **Transport** — `ANTHROPIC_UNIX_SOCKET` redirects every `forAnthropicAPI` fetch to a local
 *      socket *before* any URL or proxy handling, and the bearer-enable check short-circuits to
 *      `true` under it. The resolved base URL is irrelevant.
 *
 * Each round we deleted the newly-found names and shipped; each round the next layer surfaced. The
 * deny-list is structurally the wrong shape: it can only close instances someone has already
 * enumerated, and it silently reopens whenever Anthropic ships a new variable — in a CLI exposing
 * well over a thousand of them.
 *
 * So this file no longer spreads `process.env` and subtracts. It **starts from nothing and adds only
 * what Sloodge intends**. Every provider switch, transport selector, header injector, gateway flag,
 * and every variable that does not exist yet is excluded, because exclusion is the default. Adding a
 * passthrough is now a deliberate, reviewable act with a reason attached.
 *
 * ## How the allow-list was derived
 *
 * Empirically, against the bundled CLI 2.1.220 — not guessed:
 *
 * - Under `env -i` (a completely empty environment) the CLI boots and answers `auth status --json`
 *   correctly. **Nothing is required merely to start.**
 * - With no `PATH` at all, `claude doctor` still reports `Search: OK (bundled)` — ripgrep ships
 *   inside the binary rather than being resolved from `PATH`.
 * - Sloodge additionally denies `Bash`, `Write`, and `Edit` (client.ts), so the child's tool surface
 *   is `Read` + `Skill` + the in-process slide server. It has very little reason to shell out.
 *
 * The entries below are therefore *not* "what it needs to boot" — that set is empty. They are the OS
 * facilities a child process needs to behave correctly (locale, temp, Windows runtime) plus network
 * reachability, each justified individually. Anything unlisted does not reach the child.
 */

/** The credential the vault resolved for this session. Plaintext — main-process only, never emitted. */
export type AgentCredential =
  | { readonly kind: 'api-key'; readonly value: string }
  | { readonly kind: 'subscription'; readonly value: string }

/**
 * POSIX/general OS facilities. None is required for the CLI to start; each is admitted so the child
 * behaves like a normal process of this OS.
 */
const OS_ENV_ALLOW = [
  // Bundled ripgrep means search does not need this, but the runtime may still exec a helper, and an
  // empty PATH is a strange environment to hand a child. Non-redirecting.
  'PATH',
  // Bun runtime paths, and — per §4 — the key the macOS Keychain lookup is derived from. Dropping or
  // overriding HOME is exactly what breaks credential lookup on macOS.
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  // UTF-8 correctness in the output the event mapper parses.
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Timestamps in transcripts.
  'TZ',
] as const

/**
 * Windows runtime essentials. Node/bun genuinely break without these — DNS resolution and process
 * spawn fail with no `SystemRoot`, and `PATHEXT` decides what counts as executable. Admitted on every
 * platform (the matcher is case-insensitive and these names do not exist elsewhere). Not verified on
 * a Windows host — none was available — so this is deliberately the conservative direction: omitting
 * them would break Windows, while admitting them cannot redirect a request.
 */
const WINDOWS_ENV_ALLOW = [
  'SystemRoot',
  'windir',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
] as const

/**
 * Network reachability. **A deliberate passthrough with a stated residual risk**, per the rule that
 * anything admitted needs a reason.
 *
 * Without these Sloodge cannot reach the API from behind a corporate proxy or a TLS-inspecting
 * gateway — the app is dead for those users with no setting of ours to fix it. The residual risk is
 * real but materially smaller than the application-layer redirects we exclude: a non-MITM proxy sees
 * only `CONNECT` and never the bearer token, whereas `ANTHROPIC_BASE_URL` and `ANTHROPIC_UNIX_SOCKET`
 * hand it the credential in full. Revisit if Sloodge ever grows its own proxy setting.
 */
const NETWORK_ENV_ALLOW = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  // Corporate CA bundles; without it TLS interception fails closed and nothing connects at all.
  'NODE_EXTRA_CA_CERTS',
] as const

/**
 * The one application-layer redirect we admit — and only because it is **disclosed**. `endpoint.ts`
 * reads it back out of the built environment and the Auth tab warns, naming the host, above both
 * credential inputs. Promise and behaviour match by construction: remove it here and the warning
 * stops firing; add anything else redirecting and it must be surfaced the same way.
 */
const DISCLOSED_REDIRECT_ENV_ALLOW = ['ANTHROPIC_BASE_URL'] as const

/** Everything inherited from the parent process, in one list. */
export const INHERITED_ENV_ALLOW: readonly string[] = [
  ...OS_ENV_ALLOW,
  ...WINDOWS_ENV_ALLOW,
  ...NETWORK_ENV_ALLOW,
  ...DISCLOSED_REDIRECT_ENV_ALLOW,
]

/**
 * Windows environment names are case-insensitive (`Path`, `TEMP`, `SystemRoot` all vary in the wild),
 * so matching is case-insensitive while the caller's original key casing is preserved in the output.
 */
const ALLOW_SET = new Set(INHERITED_ENV_ALLOW.map((name) => name.toUpperCase()))

/** True when `name` may be inherited. Exported so the boundary test can enumerate against it. */
export function isInheritedEnvVar(name: string): boolean {
  return ALLOW_SET.has(name.toUpperCase())
}

/**
 * The inherited half of the subprocess environment: `base` filtered to the allow-list.
 *
 * Exported separately from `buildAuthEnv` so `getAuthStatus` can ask "what would we actually send?"
 * without needing a credential — which is what lets the endpoint disclosure be derived from the same
 * environment the child receives, rather than from a parallel reading of `process.env`.
 */
export function allowedEnv(
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && isInheritedEnvVar(key)) env[key] = value
  }
  return env
}

/**
 * Build the subprocess environment: the allow-listed inheritance plus exactly one credential.
 *
 * Returns a plain `Record<string, string>` (no `undefined` values) because the SDK hands `env`
 * straight to `spawn`, which stringifies `undefined` as the literal `"undefined"`.
 */
export function buildAuthEnv(
  base: Readonly<Record<string, string | undefined>>,
  credential: AgentCredential,
): Record<string, string> {
  const env = allowedEnv(base)
  switch (credential.kind) {
    case 'api-key':
      env['ANTHROPIC_API_KEY'] = credential.value
      break
    case 'subscription':
      // No competing credential can be present: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, the
      // apiKeyHelper descriptors and every provider switch are absent by construction, so this is
      // unambiguously the credential the client carries, on the firstParty provider.
      env['CLAUDE_CODE_OAUTH_TOKEN'] = credential.value
      break
  }
  return env
}
