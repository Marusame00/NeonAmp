(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeonAmpSort = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SORT_MODES = ['manual', 'date', 'alpha', 'filename', 'artist', 'album', 'duration'];

  const SORT_LABELS = {
    manual: 'Manual (drag)',
    date: 'Date created',
    alpha: 'Title A–Z',
    filename: 'Filename A–Z',
    artist: 'Artist',
    album: 'Album / track no.',
    duration: 'Duration'
  };

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const naturalCompare = (a, b) => collator.compare(String(a == null ? '' : a), String(b == null ? '' : b));

  const basename = (p) => {
    const s = String(p || '');
    const name = s.split(/[\\/]/).pop() || s;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  };

  const timestampOf = (track) => {
    const t = Number(track && track.addedAt);
    return Number.isFinite(t) && t > 0 ? t : 0;
  };

  const COMPARATORS = {
    date: (a, b) => timestampOf(a) - timestampOf(b) || naturalCompare(a.path, b.path),
    alpha: (a, b) => naturalCompare(a.title, b.title) || naturalCompare(a.path, b.path),
    filename: (a, b) => naturalCompare(basename(a.path), basename(b.path)),
    artist: (a, b) =>
      naturalCompare(a.artist, b.artist) ||
      naturalCompare(a.album, b.album) ||
      naturalCompare(a.title, b.title),
    album: (a, b) =>
      naturalCompare(a.album, b.album) ||
      (Number(a.trackNo) || 0) - (Number(b.trackNo) || 0) ||
      naturalCompare(a.title, b.title),
    duration: (a, b) => (Number(a.duration) || 0) - (Number(b.duration) || 0) || naturalCompare(a.title, b.title)
  };

  /**
   * Returns a new array in the requested order. `manual` keeps the stored order
   * untouched so drag-and-drop reordering survives.
   */
  function sortTracks(tracks, mode) {
    const list = Array.isArray(tracks) ? tracks.slice() : [];
    if (!mode || mode === 'manual' || !COMPARATORS[mode]) return list;
    return list.sort(COMPARATORS[mode]);
  }

  return { SORT_MODES, SORT_LABELS, sortTracks, naturalCompare, basename };
});
