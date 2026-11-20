'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac']);
const ARTWORK_NAME = /^[0-9a-f]{16}-[0-9a-f]{8}\.(jpg|jpeg|png|webp|gif|bmp)$/;

let cacheDir = null;
let metadataModule = null;

function init(dir) {
  cacheDir = dir;
  fs.mkdirSync(cacheDir, { recursive: true });
}

function getCacheDir() {
  return cacheDir;
}

function idFor(filePath) {
  return crypto.createHash('sha1').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 16);
}

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function fallbackTitle(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function extensionFor(format) {
  const f = String(format || '').toLowerCase();
  if (f.includes('png')) return 'png';
  if (f.includes('webp')) return 'webp';
  if (f.includes('gif')) return 'gif';
  if (f.includes('bmp')) return 'bmp';
  return 'jpg';
}

async function loadMetadataModule() {
  if (!metadataModule) metadataModule = await import('music-metadata');
  return metadataModule;
}

async function storeArtwork(id, picture) {
  if (!picture || !picture.data || !picture.data.length || !cacheDir) return null;
  const data = Buffer.isBuffer(picture.data) ? picture.data : Buffer.from(picture.data);
  const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 8);
  const name = `${id}-${hash}.${extensionFor(picture.format)}`;
  const target = path.join(cacheDir, name);
  try {
    await fsp.access(target);
  } catch {
    try {
      await fsp.writeFile(target, data);
    } catch (err) {
      console.warn('[metadata] artwork write failed:', err.message);
      return null;
    }
  }
  return `/artwork/${name}`;
}

function pickPicture(pictures) {
  if (!Array.isArray(pictures) || !pictures.length) return null;
  return pictures.reduce((best, pic) => {
    const size = pic && pic.data ? pic.data.length : 0;
    return size > best.size ? { pic, size } : best;
  }, { pic: null, size: -1 }).pic;
}

/**
 * Reads tags + embedded artwork for one file. Never throws: a broken or missing
 * file comes back as a playable-looking entry flagged with `missing` / `error`.
 */
async function inspectTrack(filePath) {
  const id = idFor(filePath);
  const base = {
    id,
    path: filePath,
    title: fallbackTitle(filePath),
    artist: '',
    album: '',
    duration: 0,
    artwork: null,
    missing: false,
    error: null,
    groupId: null,
    addedAt: 0,
    trackNo: 0
  };

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return { ...base, missing: true, error: 'File not found' };
  }
  if (!stat.isFile()) return { ...base, missing: true, error: 'Not a file' };
  if (!isAudioFile(filePath)) return { ...base, error: 'Unsupported format' };

  // "Date created" sorting: prefer the real creation time, fall back to mtime.
  const birth = stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : 0;
  const modified = stat.mtimeMs && stat.mtimeMs > 0 ? stat.mtimeMs : 0;
  base.addedAt = birth || modified || Date.now();

  try {
    const mm = await loadMetadataModule();
    const parsed = await mm.parseFile(filePath, { duration: true, skipCovers: false });
    const common = parsed.common || {};
    const format = parsed.format || {};
    const title = typeof common.title === 'string' && common.title.trim() ? common.title.trim() : base.title;
    const artist = Array.isArray(common.artists) && common.artists.length
      ? common.artists.filter(Boolean).join(', ')
      : (typeof common.artist === 'string' ? common.artist : '');
    const album = typeof common.album === 'string' ? common.album : '';
    const duration = Number.isFinite(format.duration) ? format.duration : 0;
    const trackNo = common.track && Number.isFinite(common.track.no) ? common.track.no : 0;
    const artwork = await storeArtwork(id, pickPicture(common.picture));
    return {
      ...base,
      title,
      artist: artist.trim(),
      album: album.trim(),
      duration,
      trackNo,
      artwork
    };
  } catch (err) {
    return { ...base, error: `Could not read tags: ${err && err.message ? err.message : 'unknown error'}` };
  }
}

function resolveArtwork(name) {
  if (!cacheDir || !ARTWORK_NAME.test(String(name || ''))) return null;
  const full = path.join(cacheDir, name);
  if (!full.startsWith(cacheDir)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

module.exports = {
  init,
  getCacheDir,
  inspectTrack,
  resolveArtwork,
  isAudioFile,
  idFor,
  AUDIO_EXTENSIONS
};
