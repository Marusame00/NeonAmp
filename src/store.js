'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OVERLAY = {
  layout: 'horizontal',
  width: 470,
  artSize: 132,
  fontSize: 17,
  radius: 18,
  accent: '#22e6ff',
  accent2: '#ff2fd0',
  textColor: '#eaf6ff',
  bgOpacity: 0.72,
  glow: 0.65,
  transparent: true,
  animations: true,
  showArtwork: true,
  showArtist: true,
  showAlbum: true,
  showTimes: true,
  showProgress: true,
  showLabel: true,
  labelText: 'NOW PLAYING',
  stopped: 'placeholder'
};

const DEFAULT_STATE = {
  queue: [],
  index: -1,
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off',
  position: 0,
  sort: 'manual',
  groups: [],
  overlay: { ...DEFAULT_OVERLAY }
};

const SORT_MODES = ['manual', 'date', 'alpha', 'filename', 'artist', 'album', 'duration'];

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const HEX = /^#[0-9a-f]{6}$/i;

function sanitizeOverlay(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULT_OVERLAY };
  out.layout = src.layout === 'compact' ? 'compact' : 'horizontal';
  out.width = Math.round(clamp(src.width, 240, 900, DEFAULT_OVERLAY.width));
  out.artSize = Math.round(clamp(src.artSize, 64, 320, DEFAULT_OVERLAY.artSize));
  out.fontSize = Math.round(clamp(src.fontSize, 12, 30, DEFAULT_OVERLAY.fontSize));
  out.radius = Math.round(clamp(src.radius, 0, 36, DEFAULT_OVERLAY.radius));
  out.bgOpacity = clamp(src.bgOpacity, 0, 1, DEFAULT_OVERLAY.bgOpacity);
  // Accept both 0..1 and 0..100 for glow so an old/percent value can never
  // produce a multi-thousand-pixel inset shadow.
  const rawGlow = Number(src.glow);
  out.glow = Number.isFinite(rawGlow)
    ? clamp(rawGlow > 1 ? rawGlow / 100 : rawGlow, 0, 1, DEFAULT_OVERLAY.glow)
    : DEFAULT_OVERLAY.glow;
  for (const key of ['accent', 'accent2', 'textColor']) {
    out[key] = HEX.test(String(src[key] || '')) ? String(src[key]) : DEFAULT_OVERLAY[key];
  }
  for (const key of ['transparent', 'animations', 'showArtwork', 'showArtist', 'showAlbum', 'showTimes', 'showProgress', 'showLabel']) {
    out[key] = typeof src[key] === 'boolean' ? src[key] : DEFAULT_OVERLAY[key];
  }
  out.labelText = String(src.labelText ?? DEFAULT_OVERLAY.labelText).slice(0, 40) || DEFAULT_OVERLAY.labelText;
  out.stopped = ['hide', 'placeholder', 'last'].includes(src.stopped) ? src.stopped : DEFAULT_OVERLAY.stopped;
  return out;
}

function sanitizeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.path !== 'string' || !raw.path) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    path: raw.path,
    title: typeof raw.title === 'string' && raw.title ? raw.title : path.basename(raw.path, path.extname(raw.path)),
    artist: typeof raw.artist === 'string' ? raw.artist : '',
    album: typeof raw.album === 'string' ? raw.album : '',
    duration: Number.isFinite(raw.duration) ? raw.duration : 0,
    artwork: typeof raw.artwork === 'string' ? raw.artwork : null,
    missing: Boolean(raw.missing),
    error: typeof raw.error === 'string' ? raw.error : null,
    groupId: typeof raw.groupId === 'string' && raw.groupId ? raw.groupId : null,
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : 0,
    trackNo: Number.isFinite(raw.trackNo) ? raw.trackNo : 0
  };
}

function sanitizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    name: String(raw.name || 'Untitled album').slice(0, 120),
    path: typeof raw.path === 'string' ? raw.path : '',
    sort: SORT_MODES.includes(raw.sort) ? raw.sort : 'manual',
    collapsed: Boolean(raw.collapsed)
  };
}

function sanitizeState(input) {
  const src = input && typeof input === 'object' ? input : {};
  const queue = Array.isArray(src.queue) ? src.queue.map(sanitizeTrack).filter(Boolean) : [];
  const groups = Array.isArray(src.groups) ? src.groups.map(sanitizeGroup).filter(Boolean) : [];
  const groupIds = new Set(groups.map((g) => g.id));
  for (const track of queue) {
    if (track.groupId && !groupIds.has(track.groupId)) track.groupId = null;
  }
  const index = Number.isInteger(src.index) && src.index >= 0 && src.index < queue.length ? src.index : (queue.length ? 0 : -1);
  return {
    queue,
    groups,
    index,
    volume: clamp(src.volume, 0, 1, DEFAULT_STATE.volume),
    muted: Boolean(src.muted),
    shuffle: Boolean(src.shuffle),
    repeat: ['off', 'all', 'one'].includes(src.repeat) ? src.repeat : 'off',
    position: clamp(src.position, 0, 86400, 0),
    sort: SORT_MODES.includes(src.sort) ? src.sort : 'manual',
    overlay: sanitizeOverlay(src.overlay)
  };
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { ...DEFAULT_STATE, overlay: { ...DEFAULT_OVERLAY } };
    this.timer = null;
    this.pending = false;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.state = sanitizeState(JSON.parse(raw));
    } catch (err) {
      if (err && err.code !== 'ENOENT') console.warn('[store] could not read state:', err.message);
      this.state = { ...DEFAULT_STATE, overlay: { ...DEFAULT_OVERLAY } };
    }
    return this.state;
  }

  merge(patch) {
    if (!patch || typeof patch !== 'object') return this.state;
    const next = { ...this.state };
    if (Array.isArray(patch.queue)) next.queue = patch.queue.map(sanitizeTrack).filter(Boolean);
    if (Array.isArray(patch.groups)) next.groups = patch.groups.map(sanitizeGroup).filter(Boolean);
    if (Number.isInteger(patch.index)) next.index = patch.index;
    if ('sort' in patch && SORT_MODES.includes(patch.sort)) next.sort = patch.sort;
    if ('volume' in patch) next.volume = clamp(patch.volume, 0, 1, next.volume);
    if ('muted' in patch) next.muted = Boolean(patch.muted);
    if ('shuffle' in patch) next.shuffle = Boolean(patch.shuffle);
    if ('repeat' in patch) next.repeat = ['off', 'all', 'one'].includes(patch.repeat) ? patch.repeat : next.repeat;
    if ('position' in patch) next.position = clamp(patch.position, 0, 86400, 0);
    if (patch.overlay) next.overlay = sanitizeOverlay({ ...next.overlay, ...patch.overlay });
    this.state = next;
    this.scheduleSave();
    return this.state;
  }

  scheduleSave() {
    this.pending = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.pending) return;
    this.pending = false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[store] could not save state:', err.message);
    }
  }
}

module.exports = { Store, DEFAULT_OVERLAY, DEFAULT_STATE, SORT_MODES, sanitizeOverlay, sanitizeTrack, sanitizeGroup, sanitizeState };
