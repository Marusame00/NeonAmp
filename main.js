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
    if (result.canceled || !result.filePaths.length) return [];
    const found = [];
    await scanFolder(result.filePaths[0], found);
    found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    return found;
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

    const persisted = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'state.json'), 'utf8'));
    check('state persisted to disk', Array.isArray(persisted.queue) && persisted.queue.length === 2 && persisted.overlay && persisted.overlay.width === 470, {
      queue: persisted.queue.length,
      width: persisted.overlay && persisted.overlay.width
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
      const tracks = await mapLimit(files, 2, (file) => metadata.inspectTrack(file));
      store.state.queue = tracks.filter(Boolean);
      store.state.index = 0;
      store.state.position = 0;
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
