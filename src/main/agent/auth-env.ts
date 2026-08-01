/**
 * Building the agent subprocess's credential environment (M2.7).
 *
 * Small, pure, and load-bearing enough to deserve its own file: it is the single point where a
 * mistake silently bills the wrong account — or sends the user's credential somewhere they did not
 * choose.
 *
 * There are **two** layers to get right, and the CLI evaluates them in this order:
 *
 *   1. **Provider selection** — which backend the client talks to at all. Env-only, and it runs
 *      FIRST.
 *   2. **Credential selection** — which secret authenticates that call.
 *
 * M2.7's first draft closed layer 2 and left layer 1 open, which is the same hijack one tier up.
 * Both are closed here.
 *
 * ## Layer 1: provider selection
 *
 * Extracted verbatim from the bundled CLI 2.1.220:
 *
 * ```js
 * function Hn(){ if(Cy()) return "gateway";
 *   return Z.CLAUDE_CODE_USE_BEDROCK ? "bedrock"
 *        : Z.CLAUDE_CODE_USE_FOUNDRY ? "foundry"
 *        : Z.CLAUDE_CODE_USE_ANTHROPIC_AWS ? "anthropicAws"
 *        : Z.CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD ? "anthropicGoogleCloud"
 *        : Z.CLAUDE_CODE_USE_MANTLE ? "mantle"
 *        : Z.CLAUDE_CODE_USE_VERTEX ? "vertex" : "firstParty" }
 * function Dc(){ return Hn() === "firstParty" }   // gates the OAuth path
 * ```
 *
 * Nothing in it consults `CLAUDE_CODE_OAUTH_TOKEN`. Under any third-party provider the OAuth path is
 * forced off, and the Bedrock branch nulls `Authorization` entirely and authenticates with AWS
 * instead. So a user with `CLAUDE_CODE_USE_BEDROCK=1` in their shell profile — a standard enterprise
 * Claude Code setup — could paste a subscription token into Settings, read "Using your Claude
 * subscription", and have that token never used: their AWS account billed, or an opaque failure.
 *
 * **Sloodge pins the firstParty provider** by deleting all six switches. The names are not guessed —
 * they are the CLI's own exported `THIRD_PARTY_PROVIDER_ENV_VARS` map. `gateway` needs no entry: its
 * predicate reads in-memory login state (`Cy(){return Ot.gatewayAuth}`), not the environment, so
 * ambient config cannot select it.
 *
 * Deleting rather than setting `"0"`: the CLI parses these through a zod boolean coercion accepting
 * only `1/true/yes/on`, so `"0"` would in fact work today — but deletion does not depend on a
 * truthiness parser staying as it is, it matches the CLI's own sibling-disabling helper (which uses
 * `void 0`), and it is the posture this file already argues for everywhere else.
 *
 * ## Layer 2: credential selection
 *
 * ```
 * ANTHROPIC_AUTH_TOKEN -> ANTHROPIC_API_KEY -> apiKeyHelper -> CLAUDE_CODE_OAUTH_TOKEN
 * ```
 *
 * **`ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN`.** We spread `process.env` — we must, or
 * the child loses `PATH` and `HOME` (§16) — so an ambient key would outrank a token the user
 * deliberately pasted. Hence: delete the losing variables, never merely decline to set them.
 *
 * ## What is deliberately NOT stripped
 *
 * `ANTHROPIC_BASE_URL` — see `endpoint.ts`. It redirects *where* the credential is sent, so it is a
 * real exposure, but stripping it would silently break the corporate-gateway deployments §4 plans
 * for, replacing a working setup with an opaque failure the user cannot fix from our UI. It is
 * **surfaced** instead: main reads it, the Auth tab warns before the user pastes anything, and the
 * copy no longer promises the credential only ever reaches Anthropic.
 */

/** The credential the vault resolved for this session. Plaintext — main-process only, never emitted. */
export type AgentCredential =
  | { readonly kind: 'api-key'; readonly value: string }
  | { readonly kind: 'subscription'; readonly value: string }

/**
 * Layer 2. Every variable that can *supply* a credential. Cleared wholesale on every branch so a
 * variable added to the user's shell can never reach the subprocess unexamined.
 */
const CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  // Parsed into outbound request headers, and named by the CLI's own retry message as a carrier of
  // the gateway token ("refresh the gateway token provided via ANTHROPIC_AUTH_TOKEN/
  // ANTHROPIC_CUSTOM_HEADERS") — i.e. it can inject an `Authorization` header behind our back.
  'ANTHROPIC_CUSTOM_HEADERS',
] as const

/**
 * Layer 1. The CLI's exported `THIRD_PARTY_PROVIDER_ENV_VARS`, plus the per-provider auth-skip
 * siblings and third-party base URLs. The six switches are what actually select a provider; the rest
 * are cleared for the same "no ambient half-configuration survives" reason — with the provider pinned
 * they are inert, and leaving inert credential-adjacent state around invites exactly the kind of
 * reasoning error that produced this fix.
 */
const PROVIDER_ENV_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
] as const

/** The six switches that actually select a provider — exported so a test can pin each one. */
export const THIRD_PARTY_PROVIDER_ENV_VARS: readonly string[] = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
]

/** Everything `buildAuthEnv` removes, in one list, so the sweep is assertable as a whole. */
export const STRIPPED_ENV_VARS: readonly string[] = [...CREDENTIAL_ENV_VARS, ...PROVIDER_ENV_VARS]

/**
 * Copy `base`, strip every credential and provider variable, then set exactly the one credential this
 * session implies.
 *
 * Returns a plain `Record<string, string>` (no `undefined` values) because the SDK hands `env`
 * straight to `spawn`, which stringifies `undefined` as the literal `"undefined"`.
 */
export function buildAuthEnv(
  base: Readonly<Record<string, string | undefined>>,
  credential: AgentCredential,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value
  }
  for (const name of STRIPPED_ENV_VARS) delete env[name]

  switch (credential.kind) {
    case 'api-key':
      env['ANTHROPIC_API_KEY'] = credential.value
      break
    case 'subscription':
      // With ANTHROPIC_API_KEY removed above and the provider pinned to firstParty by the
      // PROVIDER_ENV_VARS sweep, this is now the credential the client will actually carry.
      env['CLAUDE_CODE_OAUTH_TOKEN'] = credential.value
      break
  }
  return env
}
