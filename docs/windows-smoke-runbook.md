# Sloodge — Windows-host launch smoke test (runbook)

Verified 2026-07-31 on Windows 11 build 10.0.26200.8973, Electron 43.2.0, from WSL2 (Ubuntu).
Result: app launched and rendered on the real Windows host (not WSLg); slide-rail click worked.

## 0. Prereqs / environment

WSL side:

```bash
export PATH="/home/linuxbrew/.linuxbrew/bin:$HOME/.nvm/versions/node/v24.18.1/bin:$PATH"
```

Windows side inventory (run once):

```bash
cd /mnt/c && cmd.exe /c "where node & where npm & where pnpm & ver"
```

Observed: `C:\nvm4w\nodejs\node.exe` (node **v22.11.0**), npm 11.2.0, pnpm at
`C:\Users\baoro\AppData\Local\pnpm\pnpm.exe`.

## 1. Build in WSL

```bash
cd /home/baoro/stuff/random/sloodge
pnpm build     # typecheck + electron-vite build -> out/{main,preload,renderer}
```

The built output is platform-neutral JS. Confirm the main bundle has no external deps:

```bash
grep -n "^import\|require(" out/main/index.js
# expect only: node:url, electron
```

If that ever shows real npm deps, they must be installed in the Windows staging dir too.

## 2. Stage a Windows-runnable app dir

```bash
D=/mnt/c/sloodge-smoke
rm -rf "$D"; mkdir -p "$D"
cp -r /home/baoro/stuff/random/sloodge/out "$D/out"
cat > "$D/package.json" <<'EOF'
{ "name": "sloodge", "version": "0.0.0", "private": true, "type": "module", "main": "./out/main/index.js" }
EOF
```

`"type": "module"` is required — the built main entry is ESM (Electron 43 supports ESM main).

## 3. Get a win32-x64 Electron binary

**Do NOT rely on `npm i electron` on the Windows side.** It "succeeds" but silently leaves
`node_modules/electron/dist` missing, because Windows node is v22.11.0 and electron's
`install.js` needs >= 22.12 (`ERR_REQUIRE_ESM` on `@electron/get`).

Working approach — download the prebuilt zip from WSL (WSL has network; version must match
`devDependencies.electron` in the repo package.json):

```bash
SCRATCH=/tmp/.../scratchpad
curl -sSL -o "$SCRATCH/electron-win.zip" \
  https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-win32-x64.zip

D=/mnt/c/sloodge-smoke/node_modules/electron
mkdir -p "$D/dist"
cd "$D/dist" && unzip -oq "$SCRATCH/electron-win.zip"
printf 'electron.exe' > "$D/path.txt"
```

(The `npm i electron@43.2.0 --no-save` step is still useful to create the package skeleton,
but only the unzipped `dist/` actually matters — you can equally unzip into a bare
`node_modules/electron/dist` you create yourself.)

## 4. Launch

```bash
cd /mnt/c/sloodge-smoke && ./node_modules/electron/dist/electron.exe .
```

**Gotcha:** this returns exit 0 _immediately_ with no output. That is normal — electron.exe is a
GUI-subsystem binary, so WSL interop does not wait on it and no stdout comes back. The app is
running; do not conclude failure from the instant exit. Give it ~10s, then:

```bash
cd /mnt/c && powershell.exe -NoProfile -Command \
  "Get-Process electron -EA SilentlyContinue | Select Id,MainWindowTitle | Format-Table -AutoSize"
```

Expect one row with `MainWindowTitle = Sloodge` (plus untitled helper processes).

The app uses `app.requestSingleInstanceLock()`, so repeated launches silently no-op onto the
existing window. Kill everything before a fresh run.

## 5. Screenshot verification

**Do not use `CopyFromScreen`** — if the Windows session is locked or the window can't be
foregrounded (SetForegroundWindow from a WSL-spawned process is usually refused), you capture the
lock screen / wallpaper instead of the app. This produced a false negative on the first attempt.

Use `PrintWindow` with `PW_RENDERFULLCONTENT` (flag `2`), which pulls the DWM-composited window
content directly and works occluded/locked. Script: `C:\sloodge-smoke\shot2.ps1` (see below).

```powershell
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public struct R { public int L, T, Rt, B; }
}
"@
$p = Get-Process electron | Where-Object { $_.MainWindowTitle -eq 'Sloodge' } | Select-Object -First 1
$r = New-Object PW+R; [PW]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.Rt-$r.L), ($r.B-$r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc(); [PW]::PrintWindow($p.MainWindowHandle, $hdc, 2) | Out-Null; $g.ReleaseHdc($hdc)
$bmp.Save("C:\sloodge-smoke\shot.png", [System.Drawing.Imaging.ImageFormat]::Png)
```

Run it and pull the PNG back for inspection:

```bash
cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\sloodge-smoke\shot2.ps1'
cp /mnt/c/sloodge-smoke/shot2.png "$SCRATCH/sloodge-windows-window.png"   # then Read the PNG
```

Expected content: title bar "Sloodge", native File/Edit menu, Home ribbon (B/I/U/S, font, size,
Shape, Image, Design Mode), SLIDES rail with 3 starter slides, canvas "Untitled deck / Ask Claude
to draft your first slide", CHAT panel with empty-state + "Ask Claude…" box, status bar
"Slide 1 of 3 | theme: Ocean | 0 issues | $0.00 session | Present".

## 6. Exercise a real interaction (optional but recommended)

Electron/Chromium has **no child HWND** (`Chrome_RenderWidgetHostHWND` does not exist here —
`EnumChildWindows` returns nothing); it composites into the top-level window. Post synthetic mouse
messages to the **top-level HWND**, converting screen→client with `ScreenToClient` (client origin
sits below the title bar _and_ the native menu bar; do not hardcode the offset).

```powershell
$pt.X = $wr.L + 111; $pt.Y = $wr.T + 300      # slide-2 thumbnail, window-relative from screenshot
[C]::ScreenToClient($h, [ref]$pt) | Out-Null
$lp = [IntPtr](($pt.Y -shl 16) -bor $pt.X)
[C]::PostMessage($h, 0x0200, [IntPtr]0, $lp)  # WM_MOUSEMOVE
[C]::PostMessage($h, 0x0201, [IntPtr]1, $lp)  # WM_LBUTTONDOWN
[C]::PostMessage($h, 0x0202, [IntPtr]0, $lp)  # WM_LBUTTONUP
```

Verified effect: slide 2 highlights, canvas shows "Second slide", status bar → "Slide 2 of 3".
Full script kept at `C:\sloodge-smoke\click2.ps1`.

## 7. Cleanup

```bash
cd /mnt/c && powershell.exe -NoProfile -Command "Get-Process electron -EA SilentlyContinue | Stop-Process -Force"
```

## Gotchas summary

- `cmd.exe` invoked while cwd is a WSL UNC path warns "UNC paths are not supported" and defaults to
  `C:\Windows`. Always `cd /mnt/c/...` first, or use `cmd.exe /c "cd /d C:\dir && ..."`.
- Bash eats backslashes in PowerShell `-File 'C:\path\x.ps1'` — single-quote the Windows path.
- Windows node v22.11.0 breaks electron's postinstall (ERR_REQUIRE_ESM). Download the zip instead,
  or upgrade Windows node to >= 22.12.
- GUI exe launched from WSL exits 0 instantly and prints nothing; verify via `Get-Process`.
- Single-instance lock: stale instances swallow subsequent launches.
- `CopyFromScreen` can capture the lock screen — use `PrintWindow(hwnd, hdc, 2)`.
- Renderer DPI/zoom may differ between captures (window was rendered at a larger scale after the
  interaction); this is cosmetic, not a failure.
- No firewall prompt appeared (the app makes no network listen).
