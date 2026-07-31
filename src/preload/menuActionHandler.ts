import { isMenuAction, type MenuAction } from '../shared/ipc-contract'

/**
 * The filter the preload puts between `ipcRenderer` and the renderer's
 * listener, as a plain function so it can be tested.
 *
 * It lives outside `index.ts` for one reason: that file imports `electron` at
 * module scope, so importing it from a unit test throws before a single
 * assertion runs. The electron-touching half stays two lines there; the
 * decision — *does this value get to cross the bridge* — is here.
 *
 * The `event` argument is typed `unknown` and dropped on the floor. That is the
 * property worth stating: an `IpcRendererEvent` carries `sender`, a live
 * `ipcRenderer` handle, and forwarding it through `contextBridge` would hand
 * the renderer the whole IPC surface. Only the validated action crosses.
 */
export function createMenuActionHandler(
  listener: (action: MenuAction) => void,
): (event: unknown, action: unknown) => void {
  return (_event, action) => {
    if (isMenuAction(action)) listener(action)
  }
}
