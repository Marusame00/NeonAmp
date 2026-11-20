# NeonAmp

A compact, neon-cyberpunk desktop music player for **local MP3 / WAV files**, with a
**Now Playing overlay** you drop into OBS as a Browser Source.

- Real Electron desktop app (Windows first, macOS/Linux capable)
- Playback happens in the app; the overlay is **visual only** and never plays audio
- Local server bound to `127.0.0.1` only — nothing is uploaded, no account needed
- Playlist, volume, preferences and overlay styling persist between sessions

---

## 1. Install

Requirements: **Node.js 20+** (or 22+), npm.

**Easiest path — no terminal:** double-click **`Start NeonAmp.bat`**. It checks for
Node.js, installs dependencies if `node_modules` is missing, and launches the app.
After the first successful run you can double-click **`NeonAmp.vbs`** for a silent
launch with no console window.

Manual path:

```bash
cd "obs mp3 player"
npm install
```

If `npm install` finishes but `npm start` says Electron is missing, the Electron
binary download was skipped. Run it explicitly:

```bash
node node_modules/electron/install.js
```

## 2. Run

Double-click **`Start NeonAmp.bat`** (shows a console with any errors) or
**`NeonAmp.vbs`** (silent), or from a terminal:

```bash
npm start
```

The window opens and the overlay server starts on **http://127.0.0.1:8765/**.
If that port is taken, the app walks up (8766, 8767, ...) and shows the real URL in
the title bar and in the OBS card at the bottom right.

## 3. Add music

- **Files** — pick one or more `.mp3` / `.wav` files (also `.flac`, `.ogg`, `.m4a`, `.aac`).
- **Folder** — recursively scans a folder for supported audio.
- **Drag & drop** files or folders from Explorer straight onto the window.

Titles, artists, albums, durations and embedded cover art are read from the files.
Missing tags fall back to the filename; missing artwork falls back to a neon glyph.

## 4. Play

| Action | Control |
| --- | --- |
| Play / pause | big centre button, or `Space` |
| Stop | ■ button, or `Esc` |
| Previous / next | transport buttons, or `Ctrl+←` / `Ctrl+→` |
| Seek | click/drag the progress bar, or `←` / `→` (±5 s) |
| Volume | slider, or `M` to mute |
| Shuffle | ⇄ button, or `S` |
| Repeat off → all → one | ↻ button, or `R` |
| Reorder | drag rows up/down in the playlist |
| Filter | the search box above the playlist |

Double-click a row to play it. Single click selects it without starting playback.

## 5. OBS Browser Source

1. In OBS: **Sources → + → Browser**.
2. Paste the URL from the app (the `COPY` pill in the title bar, or **Copy URL** in
   the OBS card). Default: `http://127.0.0.1:8765/`
3. Set **Width** to the overlay width (default `470`) and **Height** to about `180`
   for the horizontal layout, `300` for compact.
4. Tick **Shutdown source when not visible** off if you want it to keep its state,
   and leave **Refresh browser when scene becomes active** off — the overlay keeps
   itself in sync over Server-Sent Events and reconnects on its own.

The overlay follows play, pause, seek, skip, stop and track changes within a few
milliseconds, and reconnects automatically if you restart the desktop app.

### Capturing the audio

OBS cannot hear the app by itself. Pick one:

- **Desktop audio** (simplest): OBS **Settings → Audio → Desktop Audio** → your
  default output device. Everything on the machine is captured.
- **Application audio capture** (Windows 10 2004+): add a **Application Audio
  Output Capture** source and select `NeonAmp.exe`. Only the player is captured.
- **Per-app routing**: send NeonAmp to a virtual cable (VB-Cable / VoiceMeeter)
  and add that cable as an Audio Input Capture source.

Do **not** enable "Control audio via OBS" on the Browser Source — the overlay has no
audio, and the player is the only thing that should make sound.

## 6. Customize the overlay

**Overlay** button (title bar) or **Customize** in the OBS card opens the settings
screen with a live preview of the exact page OBS loads.

- Layout: **horizontal** (artwork left, text right) or **compact** (stacked, centred)
- Width, artwork size, font size, corner radius, glow strength, background opacity
- Accent, second accent and text colours
- Transparent background (for OBS), animations on/off
- Show/hide artwork, artist, album, timestamps, progress bar, “Now Playing” label
- Custom label text
- What to show when stopped: placeholder, keep last track, or hide the overlay
- Copy the Browser Source URL, reset to defaults

Everything is saved to `state.json` in the app's user-data folder
(`%APPDATA%\NeonAmp` on Windows) and re-applied on launch.

## 7. Verification (optional)

`npm run selftest` launches the app against generated test media in `smoke/media`
and asserts, end to end: playlist rendering, tag + embedded-artwork extraction,
playback reaching the server, overlay receiving the track, elapsed clock, the
overlay card staying dark (a regression guard for the glow scale), overlay text,
pause freezing position, seek, next-track, stop, and state persistence. It exits
non-zero on failure and writes screenshots to `smoke/`.

Generate the test media once with ffmpeg (any 12 s MP3 with cover art plus an
untagged WAV named `01-neon-skyline.mp3` / `Untagged Track.wav` in `smoke/media`).

## 8. Packaging (optional)
`electron-builder` is intentionally **not** installed by default — it pulls a large
dependency tree. Install it only when you want an installer:

```bash
npm install --no-save electron-builder
npm run dist        # NSIS installer + portable exe in dist/
npm run dist:dir    # unpacked folder, fastest
```

## Architecture

```
main.js                 Electron main process: windows, IPC, dialogs, server lifecycle
preload.js              contextBridge API (contextIsolation on, sandbox on)
Start NeonAmp.bat      double-click launcher: checks Node, installs deps, runs the app
NeonAmp.vbs            silent launcher (no console window)
src/store.js            state schema, sanitising, debounced atomic JSON persistence
src/metadata.js         music-metadata tag/artwork extraction + artwork cache
src/server.js           localhost HTTP: SSE stream, /api/state, /audio (Range), /artwork
src/renderer/           desktop UI (index.html, styles.css, app.js)
src/overlay/            the OBS page (overlay.html, overlay.css, overlay.js, fallback.svg)
```

- **Transport**: the renderer owns an `HTMLAudioElement`; audio is streamed from the
  local server with HTTP Range support so seeking is instant and reliable.
- **Sync**: the renderer pushes playback snapshots to the main process, which
  broadcasts them to every overlay over SSE (`/events`). The overlay interpolates
  position with `requestAnimationFrame` between updates, so the bar moves smoothly
  instead of stepping.
- **Security**: server binds to `127.0.0.1`; the renderer runs sandboxed with a CSP;
  artwork filenames are validated before being served.

## Limitations

- Only local files; no streaming services, no cloud, no accounts.
- Playback formats depend on Chromium's decoders: MP3, WAV, FLAC, Ogg/Opus, AAC/M4A
  generally work; exotic codecs may not.
- The overlay is a Browser Source page — it has no audio by design.
- Gapless playback and crossfade are not implemented.
- Very large playlists render the first 1000 matches of a filter at a time.
- macOS/Linux builds are configured but only Windows has been exercised here.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Marusame00.

The MIT license covers the source code only; the NeonAmp name and logo are not
granted for use by forks.

