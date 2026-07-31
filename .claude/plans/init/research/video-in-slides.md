# Research — Video in slides (feeds roadmap M7.3/M7.4)

Researched 2026-07-31 against the FFmpeg/VLC GitHub repos, Electron docs/issues, and the npm ecosystem. Full citations inline.

## 1. What Electron 43 plays natively via `<video>`

- **H.264/AAC ship by default.** Electron's default distribution is built with proprietary codecs enabled; a separate opt-in "patent-free" ffmpeg exists per release for stripping them ([electron#13445](https://github.com/electron/electron/issues/13445), [electron#633](https://github.com/electron/electron/issues/633)). The `proprietary_codecs = false` GN file in the repo ([build/args/ffmpeg.gn](https://github.com/electron/electron/blob/main/build/args/ffmpeg.gn)) is the recipe for that *alternate* build, not the shipped default. Practical answer: **shipped Electron plays H.264/AAC in MP4 plus VP8/VP9/AV1/Opus/Vorbis in WebM/Ogg.**
- **Not playable:** MKV/AVI/WMV/MPEG-2 containers; **HEVC only with hardware decode** on the machine (no software fallback in stock Chromium — [StaZhu's guide](https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding)). iPhone `.mov`/HEVC is a "works on my machine" trap ⇒ always transcode HEVC, never pass-through.
- **In the sandboxed iframe:** `blob:` and `data:` sources work; `file://` does not cross the opaque origin. Use the same deck-asset protocol as M7 images. Autoplay in a sandboxed (cross-origin) frame needs `allow="autoplay; fullscreen"` delegation ([web.dev](https://web.dev/articles/sandboxed-iframes), [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay)); in Electron, set `webPreferences.autoplayPolicy: 'no-user-gesture-required'` explicitly, with the `app.commandLine` switch as belt-and-braces ([WebPreferences docs](https://www.electronjs.org/docs/latest/api/structures/web-preferences), [cordova-electron#102](https://github.com/apache/cordova-electron/issues/102)).

## 2. ffmpeg — the chosen tool

- **fluent-ffmpeg is dead** (archived 2025-05-22, [#1324](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324)). Spawn ffmpeg with `child_process` directly — the needed surface is ~4 fixed command templates.
- **ffmpeg-static** ([repo](https://github.com/eugeneware/ffmpeg-static)) + **ffprobe-static** ([repo](https://github.com/pietrop/ffprobe-static)): per-platform static binaries (~60–90 MB each; ffmpeg 6.1.1 at research time). **GPL builds (x264 included), package GPL-3.0** — ship as a spawned executable outside asar (`asarUnpack`), unmodified, with license notice: standard "mere aggregation" posture (Handbrake-style). If strict LGPL is ever required, an LGPL build loses the H.264 *encoder* (VP9/AV1 output instead).
- **ffmpeg.wasm** ([repo](https://github.com/ffmpegwasm/ffmpeg.wasm)): ~25 MB in renderer memory, 2–10×+ slower, no HW accel, 2 GB ceiling ([perf docs](https://ffmpegwasm.netlify.app/docs/performance/)). An Electron app has no reason to take that trade. **Rejected.**
- Command templates: remux `-c copy` (+`-movflags +faststart`); transcode `-c:v libx264 -preset veryfast -crf 23 -c:a aac`; poster `-ss <t> -frames:v 1`; probe `ffprobe -v quiet -print_format json -show_format -show_streams`.

## 3. VLC/libvlc — rejected

Every Electron/libvlc binding is unmaintained in 2026: WebChimera.js README says **[ABANDONED]** ([repo](https://github.com/RSATom/WebChimera.js/)); wcjs-prebuilt/wcjs-player, vlc-video (last publish ~5 y), node-vlc — all dead. The only DOM-integration technique (vmem→WebGL blit) is exactly the layer that rotted; native-window libvlc can't sit in the DOM z-order or scale with the slide. libvlc core is LGPL-2.1 but many plugins are GPL; ~80–100 MB installed. **Do not build on it.** With import-time normalization, Chromium plays everything on disk anyway.

## 4. Architecture decisions

- **Storage:** videos in the deck ZIP's `assets/` like images, referenced relatively; sibling generated poster (`assets/<hash>.poster.webp`); probed metadata (duration/dimensions/codec) in the manifest. Soft caps: warn ~200 MB/video, ~500 MB/deck.
- **Self-containment rule — bend, don't break:** a base64'd 100 MB video is a ~133 MB in-memory string; inlining is catastrophic. Documented exception: *slide HTML is self-contained except `assets/`-relative media references; the deck ZIP is the unit of self-containment.* (PowerPoint's own rule.) Inline only small media (<~2 MB) at export; larger stays an asset reference; single-file HTML export offers "inline (small decks)" vs "folder/zip with assets/".
- **Editor canvas:** poster-frame placeholder (`<img>` poster + duration badge or `<video poster preload="metadata">`); real playback only on explicit selection — ten rail thumbnails must not spin up ten decoders.
- **Present mode:** Chromium `<video>` with sloodge-styled custom controls (play/scrub/volume overlay, auto-hide; per-video autoplay-on-enter/loop/mute/trim via `currentTime` fencing); pause/reset on slide exit; `autoplayPolicy` set on the presentation window.
- **Import pipeline:** ffprobe → natively-playable? copy (+faststart remux) → playable codecs in wrong container? remux `-c copy` → else transcode to H.264/AAC MP4 capped at 1080p, progress UI, cancelable, temp cleanup on abort. HEVC always transcodes (risk #1).
- **Export:** PPTX media part if the writer supports it, else poster + linkout (writer capability unverified); PDF/PNG gets the poster frame with a ▶ glyph.

## 5. Risks / unknowns

1. HEVC pass-through would be machine-dependent — transcode always.
2. ffmpeg-static is community-run; hash-pin downloads, verify per-platform sizes at adoption; install-time download is a CI/proxy failure point.
3. GPL-spawn-aggregation is industry norm, not court-tested.
4. `autoplayPolicy` webPreferences knob has ignored-sometimes reports — keep the CLI switch fallback, test per-OS.
5. Multi-hundred-MB single-file HTML exports are unusable — the assets/ exception needs product wording.
6. PPTX writer media capability unverified.
7. Many mounted `<video preload="metadata">` elements pressure the renderer — posters everywhere, real `<video>` only on the active slide (aligns with M8.2 lazy mounting).
8. Long transcodes need progress + cancel UX.
