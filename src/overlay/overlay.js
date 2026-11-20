'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const stage = $('stage');
  const card = $('card');
  const art = $('art');
  const artFallback = $('artFallback');
  const titleEl = $('title');
  const artistEl = $('artist');
  const albumEl = $('album');
  const labelEl = $('label');
  const labelTextEl = $('labelText');
  const progressBlock = $('progressBlock');
  const barFill = $('barFill');
  const barHead = $('barHead');
  const timesEl = $('times');
  const elapsedEl = $('elapsed');
  const durationEl = $('duration');

  let overlay = null;
  let track = null;
  let playback = { status: 'stopped', position: 0, duration: 0, updatedAt: Date.now() };
  let receivedAt = performance.now();
  let lastArtwork = null;
  let stoppedMode = 'placeholder';
  let lastTrackKey = null;

  function fmt(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function applyOverlay(o) {
    if (!o) return;
    overlay = o;
    const root = document.documentElement.style;
    root.setProperty('--accent', o.accent);
    root.setProperty('--accent2', o.accent2);
    root.setProperty('--text', o.textColor);
    root.setProperty('--bg-opacity', String(o.transparent ? o.bgOpacity : 1));
    root.setProperty('--glow', String(Math.min(1, Math.max(0, Number(o.glow) || 0))));
    root.setProperty('--radius', `${o.radius}px`);
    root.setProperty('--art', `${o.artSize}px`);
    root.setProperty('--font', `${o.fontSize}px`);
    root.setProperty('--pad', `${Math.round(o.fontSize * 0.95)}px`);

    stage.style.width = `${o.width}px`;
    stage.style.maxWidth = '100%';
    stage.classList.toggle('layout-horizontal', o.layout !== 'compact');
    stage.classList.toggle('layout-compact', o.layout === 'compact');

    body.classList.toggle('transparent', Boolean(o.transparent));
    body.classList.toggle('no-anim', !o.animations);
    body.classList.toggle('hide-art', !o.showArtwork);

    labelEl.hidden = !o.showLabel;
    labelTextEl.textContent = o.labelText || 'NOW PLAYING';
    artistEl.hidden = !o.showArtist;
    albumEl.hidden = !o.showAlbum;
    timesEl.hidden = !o.showTimes;
    progressBlock.hidden = !o.showProgress;
    stoppedMode = o.stopped || 'placeholder';
    render();
  }

  function setArtwork(url) {
    if (url === lastArtwork) return;
    lastArtwork = url;
    if (!url) {
      art.removeAttribute('src');
      art.classList.remove('loaded');
      artFallback.hidden = false;
      return;
    }
    artFallback.hidden = false;
    art.classList.remove('loaded');
    art.onload = () => {
      art.classList.add('loaded');
      artFallback.hidden = true;
    };
    art.onerror = () => {
      art.classList.remove('loaded');
      artFallback.hidden = false;
      lastArtwork = null;
    };
    art.src = url;
  }

  function render() {
    const status = playback.status;
    body.classList.toggle('is-playing', status === 'playing');
    body.classList.toggle('is-paused', status === 'paused');
    body.classList.toggle('is-stopped', status === 'stopped');

    const stoppedHidden = status === 'stopped' && stoppedMode === 'hide';
    body.classList.toggle('stopped-hidden', stoppedHidden);

    if (status === 'stopped' && stoppedMode === 'last' && track) {
      // keep the last track's text, just no progress
    } else if (status === 'stopped' && !track) {
      titleEl.textContent = 'Nothing playing';
      artistEl.textContent = 'Add music in NeonAmp';
      albumEl.textContent = '';
      setArtwork(null);
      barFill.style.width = '0%';
      barHead.style.left = '0%';
      elapsedEl.textContent = '0:00';
      durationEl.textContent = '0:00';
      return;
    }

    if (track) {
      const key = `${track.id}|${track.title}|${track.artist}|${track.album}|${track.artwork}`;
      if (key !== lastTrackKey) {
        lastTrackKey = key;
        titleEl.textContent = track.title || 'Unknown title';
        artistEl.textContent = track.artist || 'Unknown artist';
        albumEl.textContent = track.album || '';
        setArtwork(track.artwork || null);
        if (overlay && overlay.animations) {
          card.animate(
            [
              { opacity: 0.35, transform: 'translateY(4px)' },
              { opacity: 1, transform: 'translateY(0)' }
            ],
            { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' }
          );
        }
      }
    } else {
      titleEl.textContent = 'Nothing playing';
      artistEl.textContent = 'Add music in NeonAmp';
      albumEl.textContent = '';
      setArtwork(null);
    }
  }

  function tick() {
    const duration = playback.duration || (track && track.duration) || 0;
    let position = playback.position || 0;
    if (playback.status === 'playing') {
      position += (performance.now() - receivedAt) / 1000;
    }
    if (duration > 0) position = Math.min(position, duration);
    position = Math.max(0, position);

    const pct = duration > 0 ? (position / duration) * 100 : 0;
    barFill.style.width = `${pct}%`;
    barHead.style.left = `${pct}%`;
    elapsedEl.textContent = fmt(position);
    durationEl.textContent = fmt(duration);
    requestAnimationFrame(tick);
  }

  function applySnapshot(data) {
    if (!data || typeof data !== 'object') return;
    if (data.overlay) applyOverlay(data.overlay);
    track = data.track || null;
    const p = data.playback || {};
    playback = {
      status: ['playing', 'paused', 'stopped'].includes(p.status) ? p.status : 'stopped',
      position: Number.isFinite(p.position) ? p.position : 0,
      duration: Number.isFinite(p.duration) ? p.duration : 0,
      updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : Date.now()
    };
    receivedAt = performance.now();
    render();
  }

  function connect() {
    let source;
    try {
      source = new EventSource('/events');
    } catch {
      setTimeout(connect, 1500);
      return;
    }
    source.onmessage = (event) => {
      try {
        applySnapshot(JSON.parse(event.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    source.onerror = () => {
      // EventSource retries on its own; this keeps the UI honest meanwhile.
      body.classList.add('is-stopped');
    };
  }

  // Seed immediately so the overlay is never blank while SSE connects.
  fetch('/api/state')
    .then((r) => r.json())
    .then(applySnapshot)
    .catch(() => {})
    .finally(connect);

  requestAnimationFrame(tick);
})();
