'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

const { startServer } = require('./src/server');
const metadata = require('./src/metadata');
const { Store, sanitizeOverlay, sanitizeTrack } = require('./src/store');

app.setName('NeonAmp');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'win32') app.setAppUserModelId('com.neonamp.player');

const OVERLAY_DIR = path.join(__dirname, 'src', 'overlay');
const AUDIO_EXTENSIONS = [...metadata.AUDIO_EXTENSIONS].map((ext) => ext.slice(1));
const SMOKE = process.argv.includes('--smoke');
const SELFTEST = process.argv.includes('--selftest');

if (SELFTEST) {
  // Keep automated runs away from the real user profile.
  app.setPath('userData', path.join(__dirname, 'smoke', 'userdata'));
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

let mainWindow = null;
let server = null;
let store = null;
let blockerId = null;

const snapshot = {
  playback: { status: 'stopped', position: 0, duration: 0, updatedAt: Date.now() },
  track: null,
  overlay: null
};

function currentSnapshot() {
  return {
    playback: snapshot.playback,
    track: snapshot.track,
    overlay: snapshot.overlay || (store ? store.state.overlay : null)
  };
}

function broadcastState() {
  if (server) server.broadcast(currentSnapshot());
}

function setPlaybackBlocker(active) {
  if (active && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!active && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

async function scanFolder(dir, out, depth = 0) {
  if (depth > 12 || out.length > 20000) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanFolder(full, out, depth + 1);
    } else if (entry.isFile() && metadata.isAudioFile(entry.name)) {
      out.push(full);
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function createWindow() {
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#05050b',
    title: 'NeonAmp',
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    titleBarOverlay: isWindows ? { color: '#08080f', symbolColor: '#8ff6ff', height: 46 } : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 15 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    state: store.state,
    server: { url: server.url, port: server.port, host: server.host },
    platform: process.platform,
    version: app.getVersion(),
    dataDir: app.getPath('userData')
  }));

  ipcMain.handle('library:addFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add music files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio', extensions: AUDIO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('library:addFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add a folder of music',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { files: [], folder: '' };
    const folder = result.filePaths[0];
    const found = [];
    await scanFolder(folder, found);
    found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    return { files: found, folder };
  });

  ipcMain.handle('library:inspect', async (_event, paths) => {
    if (!Array.isArray(paths)) return [];
    const clean = paths.filter((p) => typeof p === 'string' && p.length < 4096).slice(0, 5000);
    return mapLimit(clean, 6, (file) => metadata.inspectTrack(file));
  });

  ipcMain.on('player:update', (_event, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const playback = payload.playback || {};
    snapshot.playback = {
      status: ['playing', 'paused', 'stopped'].includes(playback.status) ? playback.status : 'stopped',
      position: Number.isFinite(playback.position) ? Math.max(0, playback.position) : 0,
      duration: Number.isFinite(playback.duration) ? Math.max(0, playback.duration) : 0,
      updatedAt: Date.now()
    };
    snapshot.track = payload.track ? sanitizeTrack(payload.track) : null;
    setPlaybackBlocker(snapshot.playback.status === 'playing');
    broadcastState();
  });

  ipcMain.on('overlay:update', (_event, settings) => {
    const overlay = sanitizeOverlay(settings);
    store.merge({ overlay });
    snapshot.overlay = overlay;
    broadcastState();
  });

  ipcMain.on('state:persist', (_event, payload) => {
    store.merge(payload);
    if (payload && payload.overlay) snapshot.overlay = store.state.overlay;
  });

  ipcMain.handle('overlay:open', () => {
    shell.openExternal(server.url);
    return true;
  });

  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('app:revealData', () => {
    shell.openPath(app.getPath('userData'));
    return true;
  });
}

async function runSelfTest() {
  const outDir = path.join(__dirname, 'smoke');
  await fsp.mkdir(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => mainWindow.webContents.executeJavaScript(code, true);
  const apiState = () => fetch(`${server.url}api/state`, { cache: 'no-store' }).then((r) => r.json());
  const results = {};
  let failures = 0;

  const check = (name, ok, detail) => {
    results[name] = { ok: Boolean(ok), detail };
    if (!ok) failures += 1;
    console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
  };

  try {
    await wait(1400);

    const seeded = await js('document.querySelectorAll("#tracklist .track").length');
    check('playlist renders seeded tracks', seeded === 2, { rows: seeded });

    const groupInfo = await js(`JSON.stringify({
      heads: document.querySelectorAll('#tracklist .group-head').length,
      name: (document.querySelector('#tracklist .group-name') || {}).textContent,
      sort: (document.querySelector('#tracklist .group-sort') || {}).value,
      first: (document.querySelector('#tracklist .track .t-title') || {}).textContent
    })`).then(JSON.parse);
    check('album group header renders', groupInfo.heads === 1 && groupInfo.name === 'Chrome Dreams' && groupInfo.sort === 'filename', groupInfo);
    check('per-album sort orders by filename', groupInfo.first === 'Neon Skyline', groupInfo);

    await js(`(() => { const s = document.querySelector('#tracklist .group-sort'); s.value = 'date'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await wait(300);
    const afterDate = await js('document.querySelector("#tracklist .track .t-title").textContent');
    check('per-album sort switches to date created', afterDate === 'Untagged Track', { first: afterDate });

    await js('document.querySelector("#tracklist .group-chevron").click()');
    await wait(300);
    const collapsedInfo = await js(`JSON.stringify({
      rows: document.querySelectorAll('#tracklist .track').length,
      foot: (document.querySelector('#tracklist .panel-foot') || {}).textContent || null
    })`).then(JSON.parse);
    check('collapsed album shows no filter footer', collapsedInfo.rows === 0 && collapsedInfo.foot === null, collapsedInfo);
    await js('document.querySelector("#tracklist .group-chevron").click()');
    await wait(300);

    const meta = await js(`JSON.stringify({
      title: document.getElementById('npTitle').textContent,
      artist: document.getElementById('npArtist').textContent,
      album: document.getElementById('npAlbum').textContent,
      artLoaded: document.getElementById('npArt').classList.contains('loaded'),
      badges: document.getElementById('npBadges').textContent
    })`).then(JSON.parse);
    check('tags + embedded artwork shown', meta.title === 'Neon Skyline' && meta.artist === 'Vector Ghost' && meta.artLoaded, meta);

    await js('document.getElementById("play").click()');
    await wait(1800);

    const playing = await apiState();
    check('playback reaches server as playing', playing.playback.status === 'playing' && playing.playback.position > 0.4, playing.playback);
    check('overlay receives current track', playing.track && playing.track.title === 'Neon Skyline', playing.track && playing.track.title);

    const elapsed = await js('document.getElementById("elapsed").textContent');
    check('elapsed clock advances', elapsed !== '0:00', { elapsed });

    const overlayWin = new BrowserWindow({
      width: 900,
      height: 420,
      x: 60,
      y: 60,
      show: true,
      backgroundColor: '#101018',
      webPreferences: { backgroundThrottling: false }
    });
    await overlayWin.loadURL(server.url);
    await wait(1600);
    overlayWin.moveTop();
    overlayWin.focus();
    overlayWin.setOpacity(0.99);
    overlayWin.webContents.invalidate();
    await wait(700);
    const overlayShot = await overlayWin.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, 'overlay-playing.png'), overlayShot.toPNG());
    const shotSize = overlayShot.getSize();
    const bmp = overlayShot.getBitmap();
    const px = (x, y) => {
      const i = (y * shotSize.width + x) * 4;
      return [bmp[i + 2], bmp[i + 1], bmp[i]];
    };
    // Regression guard: a mis-scaled glow once produced an opaque cyan inset
    // shadow that washed out the whole card. The card interior must stay dark.
    const cardPixel = px(500, 250);
    check('overlay card stays dark', cardPixel[0] + cardPixel[1] + cardPixel[2] < 120, { rgb: cardPixel });

    const overlayText = await overlayWin.webContents.executeJavaScript(
      `JSON.stringify({ title: document.getElementById('title').textContent, artist: document.getElementById('artist').textContent, elapsed: document.getElementById('elapsed').textContent, playing: document.body.classList.contains('is-playing') })`,
      true
    ).then(JSON.parse);
    check('overlay shows playing track', overlayText.title === 'Neon Skyline' && overlayText.playing, overlayText);
    overlayWin.destroy();

    const mainShot = await mainWindow.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, 'main-playing.png'), mainShot.toPNG());

    await js('document.getElementById("play").click()');
    await wait(500);
    const pausedA = await apiState();
    await wait(800);
    const pausedB = await apiState();
    check('pause freezes position', pausedA.playback.status === 'paused' && Math.abs(pausedB.playback.position - pausedA.playback.position) < 0.05, {
      a: pausedA.playback.position,
      b: pausedB.playback.position
    });

    await js(`(() => { const s = document.getElementById('seek'); s.value = '500'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await wait(600);
    const sought = await apiState();
    check('seek moves position', sought.playback.position > 4 && sought.playback.position < 9, sought.playback);

    await js('document.getElementById("next").click()');
    await wait(1200);
    const second = await apiState();
    check('next track plays untagged wav', second.track && second.track.title === 'Untagged Track' && second.playback.status === 'playing', {
      title: second.track && second.track.title,
      status: second.playback.status
    });

    await js('document.getElementById("stop").click()');
    await wait(500);
    const stopped = await apiState();
    check('stop resets to stopped', stopped.playback.status === 'stopped' && stopped.playback.position === 0, stopped.playback);

    // ---- explicit queue ----
    const rowTitles = await js(`JSON.stringify(Array.from(document.querySelectorAll('#tracklist .track .t-title')).map(n => n.textContent))`).then(JSON.parse);
    const secondTitle = rowTitles[1];
    const firstTitle = rowTitles[0];
    const queueTitles = `Array.from(document.querySelectorAll('#unList .un-title')).map(n => n.childNodes[0].textContent.trim())`;

    await js(`(() => { document.querySelectorAll('#tracklist .row-add')[1].click(); return true; })()`);
    await wait(400);
    const queued = await js(`JSON.stringify({
      rows: document.querySelectorAll('#unList .un-row').length,
      first: (document.querySelector('#unList .un-title') || {childNodes:[{textContent:''}]}).childNodes[0].textContent.trim(),
      count: document.getElementById('unCount').textContent
    })`).then(JSON.parse);
    check('add-to-queue button queues a track', queued.rows === 1 && queued.first === secondTitle, { ...queued, expected: secondTitle });

    await js(`(() => { document.querySelectorAll('#tracklist .row-add')[0].click(); return true; })()`);
    await wait(400);
    const queued2 = await js(`JSON.stringify({
      rows: document.querySelectorAll('#unList .un-row').length,
      order: ${queueTitles}
    })`).then(JSON.parse);
    check('queue keeps insertion order', queued2.rows === 2 && queued2.order[0] === secondTitle && queued2.order[1] === firstTitle, queued2);

    const reordered = await js(`(() => {
      const rows = document.querySelectorAll('#unList .un-row');
      const dt = new DataTransfer();
      rows[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const r = rows[0].getBoundingClientRect();
      rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: r.top + 2 }));
      rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: r.top + 2 }));
      return JSON.stringify(${queueTitles});
    })()`).then(JSON.parse);
    check('queue rows reorder by drag', reordered[0] === firstTitle && reordered[1] === secondTitle, { order: reordered });

    await js('document.getElementById("next").click()');
    await wait(1200);
    const consumed = await apiState();
    check('next consumes the queue first', consumed.track && consumed.track.title === firstTitle, {
      title: consumed.track && consumed.track.title,
      expected: firstTitle
    });
    const afterConsume = await js('document.querySelectorAll("#unList .un-row").length');
    check('consumed track leaves the queue', afterConsume === 1, { remaining: afterConsume });

    // ---- voice ducking (runs while music plays, the real use case) ----
    if ((await apiState()).playback.status !== 'playing') await js('document.getElementById("play").click()');
    await wait(500);
    const duckPlaying = (await apiState()).playback.status;

    await js('document.getElementById("duckBtn").click()');
    await wait(300);
    const duckPressed = await js('document.getElementById("duckBtn").getAttribute("aria-pressed")');
    check('duck button toggles on', duckPressed === 'true', { pressed: duckPressed });

    await js(`(() => { const s = document.getElementById('duckThreshold'); s.value = '1'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    let duckLevel = 0;
    for (let i = 0; i < 30; i += 1) {
      duckLevel = Math.max(duckLevel, Number(await js('document.getElementById("duckBtn").dataset.level')));
      if (duckLevel > 0) break;
      await wait(50);
    }
    check('mic level is measured', Number.isFinite(duckLevel) && duckLevel > 0, { level: duckLevel });

    let duckGain = 1;
    for (let i = 0; i < 15; i += 1) {
      duckGain = Number(await js('document.getElementById("duckBtn").dataset.gain'));
      if (duckGain < 0.6) break;
      await wait(100);
    }
    check('music ducks while voice detected', duckGain < 0.6 && duckPlaying === 'playing', { gain: duckGain, playback: duckPlaying });

    await js(`(() => { const s = document.getElementById('duckThreshold'); s.value = '95'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await wait(800);
    const fade = await js(`new Promise((resolve) => {
      const out = [];
      const t0 = performance.now();
      const id = setInterval(() => {
        out.push(Number(document.getElementById('duckBtn').dataset.gain));
        if (performance.now() - t0 >= 1000) { clearInterval(id); resolve(JSON.stringify(out)); }
      }, 20);
    })`).then(JSON.parse);
    const rising = fade.every((v, i) => i === 0 || v >= fade[i - 1]);
    const between = fade.filter((v) => v > 0.35 && v < 1).length;
    const early = fade[15] ?? 1;
    check('ducking fades rather than jumps', rising && between >= 3 && early < 0.99, { samples: fade.length, between, early });

    await js('document.getElementById("duckMore").click()');
    await wait(400);
    const duckShot = await mainWindow.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, 'main-duck.png'), duckShot.toPNG());

    await js('document.getElementById("duckBtn").click()');
    let duckRestored = 0;
    for (let i = 0; i < 30; i += 1) {
      duckRestored = Number(await js('document.getElementById("duckBtn").dataset.gain'));
      if (duckRestored >= 0.99) break;
      await wait(100);
    }
    check('duck off restores volume', duckRestored >= 0.99, { gain: duckRestored });
    await js('document.getElementById("stop").click()');

    await wait(1200);
    const persisted = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'state.json'), 'utf8'));
    check('state persisted to disk', Array.isArray(persisted.queue) && persisted.queue.length === 2 && persisted.overlay && persisted.overlay.width === 470, {
      queue: persisted.queue.length,
      width: persisted.overlay && persisted.overlay.width
    });
    check('album group persisted', Array.isArray(persisted.groups) && persisted.groups.length === 1 && persisted.groups[0].name === 'Chrome Dreams', {
      groups: persisted.groups && persisted.groups.length,
      sort: persisted.groups && persisted.groups[0] && persisted.groups[0].sort
    });
    check('queue persisted', Array.isArray(persisted.upNext) && persisted.upNext.length === 1, {
      upNext: persisted.upNext && persisted.upNext.length
    });
    check('ducking persisted', Boolean(persisted.ducking) && Number.isFinite(persisted.ducking.duckTo) && Number.isFinite(persisted.ducking.threshold), {
      duckTo: persisted.ducking && persisted.ducking.duckTo,
      threshold: persisted.ducking && persisted.ducking.threshold
    });

    console.log(`[selftest] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ${JSON.stringify(results)}`);
    app.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error('[selftest] crashed:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
}

async function runSmokeTest() {
  const outDir = path.join(__dirname, 'smoke');
  await fsp.mkdir(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(2500);
    const mainShot = await mainWindow.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, 'main.png'), mainShot.toPNG());

    const overlayWin = new BrowserWindow({
      width: 900,
      height: 420,
      show: false,
      backgroundColor: '#101018',
      webPreferences: { offscreen: false, backgroundThrottling: false }
    });
    await overlayWin.loadURL(server.url);
    await wait(2000);
    const overlayShot = await overlayWin.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, 'overlay.png'), overlayShot.toPNG());
    overlayWin.destroy();

    const health = await fetch(`${server.url}health`).then((r) => r.json());
    console.log('[smoke] ok', JSON.stringify({ health, url: server.url }));
    app.exit(0);
  } catch (err) {
    console.error('[smoke] failed:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    store = new Store(path.join(app.getPath('userData'), 'state.json'));
    store.load();

    metadata.init(path.join(app.getPath('userData'), 'artwork'));

    if (SELFTEST) {
      const mediaDir = path.join(__dirname, 'smoke', 'media');
      const files = ['01-neon-skyline.mp3', 'Untagged Track.wav'].map((f) => path.join(mediaDir, f));
      const tracks = (await mapLimit(files, 2, (file) => metadata.inspectTrack(file))).filter(Boolean);
      const group = { id: 'gtest', name: 'Chrome Dreams', path: mediaDir, sort: 'filename', collapsed: false };
      tracks.forEach((track, i) => {
        track.groupId = group.id;
        track.addedAt = i === 0 ? 2000 : 1000;
      });
      store.state.groups = [group];
      store.state.queue = tracks;
      // Reset everything the run mutates, so a second consecutive run starts
      // from the same state as the first. A leftover explicit queue would
      // otherwise be consumed by next() before the playlist neighbour.
      store.state.upNext = [];
      store.state.sort = 'manual';
      store.state.index = 0;
      store.state.position = 0;
      store.state.ducking = { enabled: false, duckTo: 0.35, threshold: 45, deviceId: '' };
    }

    snapshot.overlay = store.state.overlay;
    const saved = store.state;
    if (saved.queue.length && saved.index >= 0) {
      snapshot.track = saved.queue[saved.index];
      snapshot.playback = {
        status: 'stopped',
        position: saved.position || 0,
        duration: saved.queue[saved.index].duration || 0,
        updatedAt: Date.now()
      };
    }

    try {
      server = await startServer({
        getSnapshot: currentSnapshot,
        overlayDir: OVERLAY_DIR,
        preferredPort: 8765,
        host: '127.0.0.1',
        resolveAudio: (id) => {
          const track = store.state.queue.find((t) => t.id === id);
          return track ? track.path : null;
        }
      });
      console.log(`[neonamp] overlay server listening on ${server.url}`);
    } catch (err) {
      dialog.showErrorBox('NeonAmp', `Could not start the local overlay server.\n\n${err.message}`);
      app.quit();
      return;
    }

    registerIpc();
    createWindow();

    if (SELFTEST) {
      mainWindow.webContents.once('did-finish-load', () => {
        runSelfTest();
      });
    } else if (SMOKE) {
      mainWindow.webContents.once('did-finish-load', () => {
        runSmokeTest();
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (store) store.flush();
    if (server) server.close();
    setPlaybackBlocker(false);
  });
}
