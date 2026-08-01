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

The built output is platform-neutral JS. Inspect what the main bundle expects to resolve at runtime:

```bash
grep -n "^import\|require(" out/main/index.js
```

> **Stale as of M5.2.** This once printed only `node:url` and `electron`. It now also lists
> `@anthropic-ai/claude-agent-sdk`, `zod`, `parse5`, `pdf-lib`, `fflate` and `pptxgenjs` —
> electron-vite keeps `dependencies` external rather than bundling them. So the hand-staged
> `out/` + bare `package.json` approach in §2–§4 **no longer produces a runnable app**: it has no
> `node_modules`. Use the packaged build (§8) instead; that is what M5.2 exists for. §2–§4 are kept
> only as the historical record of how the launch/screenshot mechanics were first established.

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

## 8. Packaged build (M5.2) — the supported path

Verified 2026-08-01: NSIS installer built, silently installed to
`%LOCALAPPDATA%\Programs\Sloodge`, launched, and driven through slide switch → Design Mode →
Present on the real Windows host. Screenshot: `docs/media/m52-packaged-app.png`.

### 8.1 What builds where

| Artifact                                  | Buildable in WSL?                                | Why                                                                                 |
| ----------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `win-unpacked/` + `sloodge-*-win-x64.zip` | **Yes** — `pnpm exec electron-builder --win zip` | Pure file copying + 7z, no Windows tooling                                          |
| `sloodge-*-setup.exe` (NSIS)              | **No**                                           | NSIS **executes the built installer** to generate the uninstaller, which needs Wine |
| mac `.zip` (arm64 + x64)                  | **Partly** — they build, but see below           | Unsigned, and **CLI-less** on this host (no `darwin` in `supportedArchitectures`)   |
| `.dmg`                                    | **No**                                           | `electron-builder --mac` dies on `spawn sips ENOENT` — macOS-only image tooling     |

**The macOS artifacts this box can produce are not shippable.** `--mac` does emit
`sloodge-0.0.0-mac-{arm64,x64}.zip`, then fails at the dmg step on `sips`. Worse, those zips
contain `@anthropic-ai/claude-agent-sdk` but **no `claude-agent-sdk-darwin-*`** — the CLI is an
`os`-gated optionalDependency and `supportedArchitectures` here names only `current` + `win32`, so
the mac app would launch with a dead chat panel. M9.2 must build macOS on real hardware, where
`current` _is_ darwin. Adding `darwin` to `supportedArchitectures` would fix the payload but not
the dmg, and costs another ~275 MB per variant on every install.

#### Where Wine actually comes in — and what is still unexplained

Only **one** step needs it. `makensis` compiling the installer does not:
`~/.cache/electron-builder/nsis-3.0.4.1/**/linux/makensis` is an `ELF 64-bit LSB executable,
x86-64`, run natively. Wine is invoked once, to **execute the freshly built installer so it can
emit its own uninstaller** (`app-builder-lib/out/targets/NsisTarget.js`). That single invocation is
what fails here.

`build.toolsets.wine: "1.0.1"` is set so electron-builder downloads its own Wine rather than
needing a system one (there is no sudo on this box). The download succeeds and
`wine --version` prints `wine-11.0`, but running any exe fails:

```bash
W=~/.cache/electron-builder/wine@1.0.1/wine-11.0-linux-x86_64-*
WINEPREFIX=$W/wine-home $W/bin/wine cmd /c "echo hello"
# wine: failed to load .../lib/wine/x86_64-unix/ntdll.dll error c0000135
# 0024:err:environ:run_wineboot failed to start wineboot 1
```

**The root cause is not identified.** Do not repeat this earlier guess, which was wrong: an earlier
revision of this runbook claimed the bundle "ships no `x86_64-windows/` PE directory". That was an
inference from `tar -tJf … | grep -c x86_64-windows` → `0`, which only says a directory of that
_name_ is absent. The tarball does ship the Windows side — 191 entries under
`wine-home/drive_c/windows/system32/`, including a `PE32+ executable (console) x86-64`
`wineboot.exe` — at exactly the prefix `toolsets/wine.js:79` resolves (`<toolset>/wine-home`), and
that path is validated at `:80-84`. So the bundle is not obviously incomplete, and why this one
`wine` call fails under WSL2 remains an open question. Plausible unexplored leads: the WSL2 kernel,
the `LD_LIBRARY_PATH` electron-builder injects, or a missing 32-bit/loader dependency.

The `toolsets` key is kept regardless: it is a real electron-builder option, and it is inert on a
Windows host (`WineVmManager.execWine` returns early when `process.platform === 'win32'`).

### 8.2 Building the NSIS installer on the Windows host

Build the app dir in WSL, then let Windows do the NSIS step from the _prepackaged_ output:

```bash
# WSL
pnpm exec electron-builder --win zip           # -> release/win-unpacked + release/*.zip
cp release/sloodge-0.0.0-win-x64.zip /mnt/c/sloodge-m52/
cd /mnt/c && powershell.exe -NoProfile -Command \
  "Expand-Archive -Path 'C:\sloodge-m52\sloodge-0.0.0-win-x64.zip' -DestinationPath 'C:\sloodge-m52\win-unpacked' -Force"
```

Copy the **zip** (≈230 MB), not `win-unpacked/` (≈665 MB) — the 9p mount is slow.

`C:\sloodge-m52\builder\` holds a throwaway `package.json` (`name: sloodge`, `version`, and
`electron-builder` as the only devDependency) plus an `electron-builder.yml` mirroring the repo's
`build.win`/`build.nsis` block. **`electronVersion: 43.2.0` must be set explicitly** — with
`--prepackaged` there is no electron in `node_modules` to infer it from.

```bash
cd /mnt/c && cmd.exe /c "cd /d C:\sloodge-m52\builder && npm install --ignore-scripts --no-audit"
cd /mnt/c && cmd.exe /c "cd /d C:\sloodge-m52\builder && set NODE_OPTIONS=--experimental-require-module && npx electron-builder --win nsis --prepackaged C:\sloodge-m52\win-unpacked"
```

`NODE_OPTIONS=--experimental-require-module` is **required** on this machine: Windows node is
v22.11.0 and electron-builder 26 `require()`s the ESM-only `@noble/hashes` (`ERR_REQUIRE_ESM`).
`require(esm)` is unflagged only from node 22.12. Upgrading Windows node removes the need.

### 8.3 Install, launch, drive

```bash
cd /mnt/c && powershell.exe -NoProfile -Command \
  "Start-Process -FilePath 'C:\sloodge-m52\builder\release\sloodge-0.0.0-setup.exe' -ArgumentList '/S' -Wait"
```

`/S` silently installs the assisted (`oneClick: false`) installer to
`%LOCALAPPDATA%\Programs\Sloodge` (`perMachine: false`, so no UAC prompt). Then:

```bash
cd /mnt/c && powershell.exe -NoProfile -Command \
  "Start-Process \"\$env:LOCALAPPDATA\Programs\Sloodge\Sloodge.exe\"; Start-Sleep -Seconds 15; Get-Process Sloodge | Select Id,MainWindowTitle"
```

The process is now **`Sloodge`**, not `electron` — the §5/§6 scripts hardcoded `Get-Process electron`
and silently find nothing against a packaged build. `C:\sloodge-m52\shot.ps1` and `click.ps1` are
parameterised versions (`-ProcName`, `-X/-Y`, `-Out`) of those.

### 8.4 What the packaged app must contain (M2.4 + M5.2 hazards)

```bash
D="/mnt/c/Users/baoro/AppData/Local/Programs/Sloodge"
find "$D/resources/skills" -type f                                  # 3x SKILL.md + icons.md
ls "$D/resources/app.asar.unpacked/node_modules/@anthropic-ai/"      # sdk + sdk-win32-x64, SIBLINGS
```

The sibling layout is load-bearing: the SDK finds its CLI via
`require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')` anchored at `sdk.mjs`'s
own realpath, with no PATH fallback. Both packages must be `asarUnpack`ed (a binary cannot be
spawned from inside an archive) and must stay siblings.

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
- A packaged app's process is `Sloodge`, not `electron` — `Get-Process electron` finds nothing.
- pnpm installs only the host's variant of an `os`-gated optionalDependency. Cross-packing Windows
  from Linux needs `supportedArchitectures` in `pnpm-workspace.yaml`, or the installer ships with
  no `claude.exe` and **nothing in the build fails**.
- electron-builder does _not_ filter those platform packages by their own `os`/`cpu` fields — the
  275 MB Linux CLI rode along inside the Windows app until `win.files` excluded it explicitly.
- **Every** platform needs its own complete `files` list. A platform with no block falls through to
  electron-builder's default `**/*` and packages the whole repo — that was `linux`, so `pnpm
pack:dir` on this dev box produced a 63.7 MB asar with 184 `src/`, 145 `tests/` and 36 `docs/`
  entries plus a foreign 254 MB `claude.exe`, against 37.7 MB for the shipped Windows one.
- **Do not hoist the shared exclusions to a top-level `files`.** It reads like the obvious fix and
  `fileMatcher.js:250-253` looks like it supports it (`addPatterns(config.files)` then
  `addPatterns(customBuildOptions.files)` into one matcher). Measured on real `--win --dir` runs:

  | `files` shape               | asar     | src | tests | docs | foreign CLI |
  | --------------------------- | -------- | --- | ----- | ---- | ----------- |
  | top-level only              | 37.7 MB  | 0   | 0     | 0    | 3           |
  | top-level + platform        | 427.9 MB | 151 | 131   | 34   | 0           |
  | platform only, full list    | 37.7 MB  | 0   | 0     | 0    | 0           |
  | both carrying the full list | 401.9 MB | 0   | 0     | 0    | 0           |

  Once a platform block exists, the app-source matcher takes the platform list and the top-level
  list is routed to the _node_modules_ matcher instead — `release/builder-debug.yml` prints both
  (`firstOrDefaultFilePatterns` vs `nodeModuleFilePatterns`) and shows the split. So the exclusions
  are duplicated across `win`/`mac`/`linux` on purpose; `build-config.test.ts` guards the shape.

- Icons are **deferred**: `directories.buildResources: "build"` names a dir that does not exist yet
  and no `icon` is set, so every artifact carries the default Electron icon. M9.1 must add
  `build/icon.png` (electron-builder auto-discovers it) before the release.
