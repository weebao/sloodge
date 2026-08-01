/**
 * Building the agent subprocess's credential environment (M2.7).
 *
 * This is small, pure, and load-bearing enough to deserve its own file: it is the single point where
 * a mistake silently bills the wrong account.
 *
 * ## The precedence trap
 *
 * The Claude CLI resolves credentials in this order (verified against the bundled binary, which
 * carries an explicit warning string about a shell-set `CLAUDE_CODE_OAUTH_TOKEN` conflicting with the
 * logged-in account):
 *
 * ```
 * Bedrock/Vertex/Foundry → ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY → apiKeyHelper
 *   → CLAUDE_CODE_OAUTH_TOKEN → interactive subscription login
 * ```
 *
 * **`ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN`.** M2.1 spreads `process.env` into the
 * subprocess (necessary — the TS SDK's `env` *replaces* the environment, so dropping it would cost
 * the child its PATH and HOME). That spread means a developer's ambient `ANTHROPIC_API_KEY`, or one
 * left in a user's shell profile, would silently outrank a subscription token the user explicitly
 * chose — charging their console account while the UI says "using your Claude subscription".
 *
 * So the rule is: **delete the losing variables, never merely decline to set them.** Every branch
 * below writes exactly one credential var and removes every other one it could lose to.
 */

/** The credential the vault resolved for this session. Plaintext — main-process only, never emitted. */
export type AgentCredential =
  | { readonly kind: 'api-key'; readonly value: string }
  | { readonly kind: 'subscription'; readonly value: string }

/**
 * Every environment variable that can supply or redirect Anthropic credentials. Cleared wholesale on
 * every branch so a variable added to the user's shell can never reach the subprocess unexamined.
 *
 * `ANTHROPIC_BASE_URL` is deliberately **not** here: it is a proxy/gateway setting rather than a
 * credential, and a user routing through their own endpoint must keep working (§4's future note).
 */
const CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
] as const

/**
 * Copy `base`, strip every credential variable, then set exactly the one this credential implies.
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
  for (const name of CREDENTIAL_ENV_VARS) delete env[name]

  switch (credential.kind) {
    case 'api-key':
      env['ANTHROPIC_API_KEY'] = credential.value
      break
    case 'subscription':
      // With ANTHROPIC_API_KEY removed above, this is now the highest-priority source present.
      env['CLAUDE_CODE_OAUTH_TOKEN'] = credential.value
      break
  }
  return env
}
