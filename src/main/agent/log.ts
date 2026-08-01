/**
 * The main process's default log sink for agent diagnostics.
 *
 * It exists so there is exactly one `console` call behind the agent's logging rather than one per
 * call site, and so every consumer takes an injectable `log` seam that tests can capture — the
 * §8 skill assertions are only useful if a test can prove they were actually written somewhere.
 *
 * 50-agent-integration.md §2 routes SDK stderr through a real logger (`log.debug`); when that
 * logger lands this is the single line that changes.
 */
export type AgentLog = (message: string) => void

export const defaultAgentLog: AgentLog = (message) => {
  // eslint-disable-next-line no-console -- the main process's only diagnostic channel until a real logger lands
  console.warn(message)
}
