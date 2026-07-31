import type { JSX } from 'react'
import { AppShell } from './AppShell'

/** Renderer entry component. The layout itself lives in AppShell. */
export function App(): JSX.Element {
  return <AppShell />
}
