'use strict';

(function () {
  const api = window.neonamp;
  const $ = (id) => document.getElementById(id);

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

  const state = {
    queue: [],
    index: -1,
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: 'off',
    overlay: { ...DEFAULT_OVERLAY }
  };

  let server = { url: 'http://127.0.0.1:8765/' };
  let filter = '';
  let dragFrom = -1;
  let saveTimer = null;
  let lastSent = 0;
  let autoAdvanceTimer = null;

  const audio = new Audio();
  audio.preload = 'metadata';

  /* ---------------- helpers ---------------- */
  const fmt = (seconds) => {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  };

  const ext = (p) => (String(p).split('.').pop() || '').toUpperCase();

  function toast(message, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast${kind === 'err' ? ' err' : ''}`;
    const bar = document.createElement('span');
    bar.className = 'bar';
    const text = document.createElement('span');
    text.textContent = message;
    el.append(bar, text);
    $('toasts').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 220ms, transform 220ms';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 240);
    }, 3200);
  }

  function setFill(el, pct) {
    el.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
  }

  function currentTrack() {
    return state.index >= 0 && state.index < state.queue.length ? state.queue[state.index] : null;
  }

  function status() {
    if (audio.paused) return audio.currentTime > 0 && audio.src ? 'paused' : 'stopped';
    return 'playing';
  }

  /* ---------------- persistence ---------------- */
  function persist(immediate = false) {
    const payload = {
      queue: state.queue,
      index: state.index,
      volume: state.volume,
      muted: state.muted,
      shuffle: state.shuffle,
      repeat: state.repeat,
      position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0
    };
    if (immediate) {
      clearTimeout(saveTimer);
      saveTimer = null;
      api.persist(payload);
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      api.persist(payload);
    }, 700);
  }

  /* ---------------- overlay sync ---------------- */
  function pushPlayer(force = false) {
    const now = performance.now();
    if (!force && now - lastSent < 220) return;
    lastSent = now;
    const track = currentTrack();
    api.updatePlayer({
      playback: {
        status: status(),
        position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        duration: Number.isFinite(audio.duration) ? audio.duration : (track ? track.duration : 0)
      },
      track: track
        ? {
            id: track.id,
            path: track.path,
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
            artwork: track.artwork,
            missing: Boolean(track.missing),
            error: track.error || null
          }
        : null
    });
  }

  /* ---------------- rendering ---------------- */
  function renderTracklist() {
    const list = $('tracklist');
    const q = filter.trim().toLowerCase();
    const items = [];
    state.queue.forEach((track, index) => {
      if (!q) {
        items.push({ track, index });
        return;
      }
      const hay = `${track.title} ${track.artist} ${track.album} ${track.path}`.toLowerCase();
      if (hay.includes(q)) items.push({ track, index });
    });

    const capped = items.slice(0, 1000);
    const frag = document.createDocumentFragment();

    for (const { track, index } of capped) {
      const row = document.createElement('div');
      row.className = 'track';
      row.dataset.index = String(index);
      row.draggable = true;
      row.setAttribute('role', 'option');
      if (index === state.index) {
        row.classList.add('active');
        if (!audio.paused) row.classList.add('playing');
      }
      if (track.missing || track.error) row.classList.add('missing');

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(index + 1).padStart(2, '0');

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (track.artwork) {
        const img = document.createElement('img');
        img.src = server.url.replace(/\/$/, '') + track.artwork;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => {
          thumb.innerHTML = '';
          thumb.appendChild(noteIcon());
        };
        thumb.appendChild(img);
      } else {
        thumb.appendChild(noteIcon());
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 't-title';
      title.textContent = track.title || 'Unknown title';
      const sub = document.createElement('div');
      sub.className = 't-sub';
      sub.textContent = track.error
        ? track.error
        : [track.artist || 'Unknown artist', track.album].filter(Boolean).join(' · ');
      meta.append(title, sub);

      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = track.duration ? fmt(track.duration) : '--:--';

      const eq = document.createElement('span');
      eq.className = 'eq';
      for (let i = 0; i < 4; i += 1) eq.appendChild(document.createElement('i'));

      row.append(idx, thumb, meta, dur, eq);
      row.addEventListener('dblclick', () => playIndex(index));
      row.addEventListener('click', () => selectIndex(index, false));
      row.addEventListener('dragstart', (e) => {
        dragFrom = index;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', String(index));
        } catch {
          /* ignore */
        }
      });
      row.addEventListener('dragend', () => {
        dragFrom = -1;
        row.classList.remove('dragging');
        clearDropMarks();
      });
      row.addEventListener('dragover', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        clearDropMarks();
        row.classList.add(after ? 'drop-after' : 'drop-before');
      });
      row.addEventListener('drop', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        moveTrack(dragFrom, index, after);
        clearDropMarks();
      });

      frag.appendChild(row);
    }

    list.innerHTML = '';
    list.appendChild(frag);
    $('emptyState').hidden = state.queue.length > 0;
    list.hidden = state.queue.length === 0;
    $('trackCount').textContent = String(state.queue.length);
    $('totalTime').textContent = fmt(state.queue.reduce((sum, t) => sum + (t.duration || 0), 0));
    if (items.length > capped.length) {
      const note = document.createElement('div');
      note.className = 'panel-foot';
      note.textContent = `Showing first ${capped.length} of ${items.length} matches — refine the filter.`;
      list.appendChild(note);
    }
  }

  function noteIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M9 18V5l10-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z');
    svg.appendChild(path);
    return svg;
  }

  function clearDropMarks() {
    document.querySelectorAll('.track.drop-before, .track.drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  function renderNowPlaying() {
    const track = currentTrack();
    const art = $('npArt');
    const fallback = $('npFallback');

    if (!track) {
      $('npTitle').textContent = 'Nothing playing';
      $('npArtist').textContent = 'Add music to get started';
      $('npAlbum').textContent = '';
      $('npBadges').innerHTML = '';
      art.removeAttribute('src');
      art.classList.remove('loaded');
      fallback.hidden = false;
      return;
    }

    $('npTitle').textContent = track.title || 'Unknown title';
    $('npArtist').textContent = track.artist || 'Unknown artist';
    $('npAlbum').textContent = track.album || '';

    const badges = $('npBadges');
    badges.innerHTML = '';
    const addBadge = (text, warn) => {
      const b = document.createElement('span');
      b.className = `badge${warn ? ' warn' : ''}`;
      b.textContent = text;
      badges.appendChild(b);
    };
    addBadge(ext(track.path));
    if (track.duration) addBadge(fmt(track.duration));
    if (track.missing) addBadge('MISSING FILE', true);
    else if (track.error) addBadge('UNREADABLE', true);

    if (track.artwork) {
      const url = server.url.replace(/\/$/, '') + track.artwork;
      if (art.getAttribute('src') !== url) {
        art.classList.remove('loaded');
        fallback.hidden = false;
        art.onload = () => {
          art.classList.add('loaded');
          fallback.hidden = true;
        };
        art.onerror = () => {
          art.classList.remove('loaded');
          fallback.hidden = false;
        };
        art.src = url;
      }
    } else {
      art.removeAttribute('src');
      art.classList.remove('loaded');
      fallback.hidden = false;
    }
  }

  function renderTransport() {
    const playing = !audio.paused && Boolean(audio.src);
    $('playIcon').classList.toggle('hidden', playing);
    $('pauseIcon').classList.toggle('hidden', !playing);
    $('play').title = playing ? 'Pause (Space)' : 'Play (Space)';
    $('shuffle').setAttribute('aria-pressed', String(state.shuffle));
    $('repeat').setAttribute('aria-pressed', String(state.repeat !== 'off'));
    $('repeat').classList.toggle('repeat-one-on', state.repeat === 'one');
    $('mute').setAttribute('aria-pressed', String(state.muted));
    $('volIcon').classList.toggle('hidden', state.muted || state.volume === 0);
    $('muteIcon').classList.toggle('hidden', !(state.muted || state.volume === 0));
    document.querySelectorAll('.track.active').forEach((row) => {
      row.classList.toggle('playing', playing);
    });
  }

  function renderTimes() {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (currentTrack() ? currentTrack().duration : 0);
    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    $('elapsed').textContent = fmt(position);
    $('duration').textContent = fmt(duration);
    const pct = duration > 0 ? (position / duration) * 100 : 0;
    const seek = $('seek');
    if (!seek.matches(':active')) {
      seek.value = String(Math.round(pct * 10));
      setFill(seek, pct);
    }
  }

  function renderUpNext() {
    const list = $('unList');
    const wrap = $('upnext');
    list.innerHTML = '';

    if (!state.queue.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;

    const upcoming = [];
    for (let i = state.index + 1; i < state.queue.length && upcoming.length < 4; i += 1) {
      upcoming.push({ track: state.queue[i], index: i });
    }
    if (!upcoming.length && state.repeat !== 'off') {
      for (let i = 0; i < state.queue.length && upcoming.length < 4; i += 1) {
        if (i === state.index) continue;
        upcoming.push({ track: state.queue[i], index: i });
      }
    }

    $('unCount').textContent = upcoming.length ? `${upcoming.length} queued` : 'end of playlist';

    if (!upcoming.length) {
      const empty = document.createElement('div');
      empty.className = 'un-empty';
      empty.textContent = 'Nothing queued — repeat is off.';
      list.appendChild(empty);
      return;
    }

    for (const { track, index } of upcoming) {
      const row = document.createElement('div');
      row.className = 'un-row';
      const idx = document.createElement('span');
      idx.className = 'un-idx';
      idx.textContent = String(index + 1).padStart(2, '0');
      const title = document.createElement('div');
      title.className = 'un-title';
      title.textContent = track.title || 'Unknown title';
      if (track.artist) {
        const sub = document.createElement('span');
        sub.textContent = ` — ${track.artist}`;
        title.appendChild(sub);
      }
      const dur = document.createElement('span');
      dur.className = 'un-dur';
      dur.textContent = track.duration ? fmt(track.duration) : '--:--';
      row.append(idx, title, dur);
      row.addEventListener('click', () => playIndex(index));
      list.appendChild(row);
    }
  }

  function renderAll() {
    renderTracklist();
    renderNowPlaying();
    renderTransport();
    renderTimes();
    renderUpNext();
  }

  /* ---------------- playback ---------------- */
  function loadTrack(index, autoplay) {
    const track = state.queue[index];
    if (!track) return;
    state.index = index;
    clearTimeout(autoAdvanceTimer);

    audio.src = `${server.url.replace(/\/$/, '')}/audio/${track.id}`;
    audio.load();
    try {
      audio.currentTime = 0;
    } catch {
      /* ignore */
    }

    renderAll();
    pushPlayer(true);
    persist();

    if (autoplay) {
      audio.play().catch((err) => {
        toast(`Could not play: ${err.message}`, 'err');
      });
    }
  }

  function selectIndex(index, autoplay) {
    if (index === state.index && audio.src) {
      if (autoplay) togglePlay();
      return;
    }
    loadTrack(index, autoplay);
  }

  function playIndex(index) {
    loadTrack(index, true);
  }

  function togglePlay() {
    if (!state.queue.length) {
      toast('Add some MP3 or WAV files first.');
      return;
    }
    if (state.index < 0) {
      loadTrack(0, true);
      return;
    }
    if (!audio.src) {
      loadTrack(state.index, true);
      return;
    }
    if (audio.paused) {
      audio.play().catch((err) => toast(`Could not play: ${err.message}`, 'err'));
    } else {
      audio.pause();
    }
  }

  function stopPlayback() {
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      /* ignore */
    }
    renderAll();
    pushPlayer(true);
    persist();
  }

  function nextIndex(auto) {
    const n = state.queue.length;
    if (!n) return -1;
    if (state.shuffle && n > 1) {
      let pick = state.index;
      let guard = 0;
      while (pick === state.index && guard < 40) {
        pick = Math.floor(Math.random() * n);
        guard += 1;
      }
      return pick;
    }
    if (state.index + 1 < n) return state.index + 1;
    if (state.repeat === 'all' || !auto) return 0;
    return -1;
  }

  function next(auto = false) {
    const index = nextIndex(auto);
    if (index < 0) {
      stopPlayback();
      return;
    }
    loadTrack(index, true);
  }

  function prev() {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      renderTimes();
      pushPlayer(true);
      return;
    }
    const n = state.queue.length;
    if (!n) return;
    const index = state.index - 1 >= 0 ? state.index - 1 : (state.repeat === 'all' ? n - 1 : 0);
    loadTrack(index, true);
  }

  function moveTrack(from, to, after) {
    if (from === to || from < 0 || to < 0) return;
    const [item] = state.queue.splice(from, 1);
    let target = to;
    if (from < to) target -= 1;
    if (after) target += 1;
    target = Math.max(0, Math.min(state.queue.length, target));
    state.queue.splice(target, 0, item);

    if (state.index === from) state.index = target;
    else if (from < state.index && target >= state.index) state.index -= 1;
    else if (from > state.index && target <= state.index) state.index += 1;

    renderTracklist();
    persist();
  }

  /* ---------------- audio events ---------------- */
  audio.addEventListener('timeupdate', () => {
    renderTimes();
    pushPlayer();
  });

  audio.addEventListener('loadedmetadata', () => {
    const track = currentTrack();
    if (track && Number.isFinite(audio.duration) && audio.duration > 0) {
      track.duration = audio.duration;
      track.missing = false;
      track.error = null;
      renderTracklist();
      renderNowPlaying();
      persist();
    }
    renderTimes();
    pushPlayer(true);
  });

  audio.addEventListener('play', () => {
    renderTransport();
    pushPlayer(true);
    persist();
  });

  audio.addEventListener('pause', () => {
    renderTransport();
    pushPlayer(true);
    persist();
  });

  audio.addEventListener('ended', () => {
    if (state.repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    next(true);
  });

  audio.addEventListener('error', () => {
    const track = currentTrack();
    if (!track) return;
    track.missing = true;
    track.error = 'File missing or unreadable';
    renderTracklist();
    renderNowPlaying();
    pushPlayer(true);
    persist();
    toast(`Skipping “${track.title}” — file missing or unreadable.`, 'err');
    clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = setTimeout(() => next(true), 1400);
  });

  /* ---------------- library ---------------- */
  async function addPaths(paths) {
    if (!paths || !paths.length) return;
    const known = new Set(state.queue.map((t) => t.path.toLowerCase()));
    const fresh = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !p) continue;
      if (known.has(p.toLowerCase())) continue;
      known.add(p.toLowerCase());
      fresh.push(p);
    }
    if (!fresh.length) {
      toast('Those files are already in the playlist.');
      return;
    }

    toast(`Reading ${fresh.length} file${fresh.length === 1 ? '' : 's'}…`);
    const inspected = await api.inspect(fresh);
    const valid = inspected.filter(Boolean);
    if (!valid.length) {
      toast('No supported audio files found.', 'err');
      return;
    }
    state.queue.push(...valid);
    if (state.index < 0) state.index = 0;
    renderAll();
    persist(true);
    const bad = valid.filter((t) => t.error).length;
    toast(`Added ${valid.length} track${valid.length === 1 ? '' : 's'}${bad ? ` (${bad} unreadable)` : ''}.`);
  }

  async function addFiles() {
    const paths = await api.addFiles();
    await addPaths(paths);
  }

  async function addFolder() {
    const paths = await api.addFolder();
    if (!paths.length) {
      toast('No MP3 or WAV files in that folder.', 'err');
      return;
    }
    await addPaths(paths);
  }

  /* ---------------- overlay settings ---------------- */
  function overlayInputs() {
    return {
      layout: document.querySelector('#layoutSeg button.on')?.dataset.layout || 'horizontal',
      width: Number($('width').value),
      artSize: Number($('artSize').value),
      fontSize: Number($('fontSize').value),
      radius: Number($('radius').value),
      glow: Number($('glow').value) / 100,
      bgOpacity: Number($('bgOpacity').value) / 100,
      accent: $('accent').value,
      accent2: $('accent2').value,
      textColor: $('textColor').value,
      showArtwork: $('showArtwork').checked,
      showArtist: $('showArtist').checked,
      showAlbum: $('showAlbum').checked,
      showTimes: $('showTimes').checked,
      showProgress: $('showProgress').checked,
      showLabel: $('showLabel').checked,
      transparent: $('transparent').checked,
      animations: $('animations').checked,
      labelText: $('labelText').value,
      stopped: $('stopped').value
    };
  }

  function fillOverlayInputs(o) {
    document.querySelectorAll('#layoutSeg button').forEach((b) => {
      b.classList.toggle('on', b.dataset.layout === o.layout);
    });
    $('width').value = String(o.width);
    $('artSize').value = String(o.artSize);
    $('fontSize').value = String(o.fontSize);
    $('radius').value = String(o.radius);
    $('glow').value = String(Math.round(o.glow * 100));
    $('bgOpacity').value = String(Math.round(o.bgOpacity * 100));
    $('accent').value = o.accent;
    $('accent2').value = o.accent2;
    $('textColor').value = o.textColor;
    $('showArtwork').checked = o.showArtwork;
    $('showArtist').checked = o.showArtist;
    $('showAlbum').checked = o.showAlbum;
    $('showTimes').checked = o.showTimes;
    $('showProgress').checked = o.showProgress;
    $('showLabel').checked = o.showLabel;
    $('transparent').checked = o.transparent;
    $('animations').checked = o.animations;
    $('labelText').value = o.labelText;
    $('stopped').value = o.stopped;
    updateOutputs(o);
  }

  function updateOutputs(o) {
    $('widthOut').textContent = `${o.width}px`;
    $('artSizeOut').textContent = `${o.artSize}px`;
    $('fontSizeOut').textContent = `${o.fontSize}px`;
    $('radiusOut').textContent = `${o.radius}px`;
    $('glowOut').textContent = `${Math.round(o.glow * 100)}%`;
    $('bgOpacityOut').textContent = `${Math.round(o.bgOpacity * 100)}%`;
    $('previewSize').textContent = `${o.width} × ${o.layout === 'compact' ? 300 : 180}`;
    const frame = $('previewFrame');
    frame.style.width = `${o.width}px`;
    frame.style.height = o.layout === 'compact' ? '300px' : '180px';
    fitPreview();
  }

  function fitPreview() {
    const stage = $('previewStage');
    const frame = $('previewFrame');
    if (!stage || !frame) return;
    const w = Number(frame.style.width.replace('px', '')) || 470;
    const h = Number(frame.style.height.replace('px', '')) || 180;
    const scale = Math.min(1, (stage.clientWidth - 24) / w, (stage.clientHeight - 24) / h);
    frame.style.transform = `scale(${Math.max(0.2, scale)})`;
  }

  function applyOverlayFromInputs() {
    const overlay = overlayInputs();
    state.overlay = overlay;
    api.updateOverlay(overlay);
    updateOutputs(overlay);
  }

  /* ---------------- settings modal ---------------- */
  function openSettings() {
    fillOverlayInputs(state.overlay);
    $('settingsModal').classList.add('open');
    $('settingsModal').setAttribute('aria-hidden', 'false');
    setTimeout(fitPreview, 30);
  }

  function closeSettings() {
    $('settingsModal').classList.remove('open');
    $('settingsModal').setAttribute('aria-hidden', 'true');
  }

  function bindSettings() {
    document.querySelectorAll('#layoutSeg button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#layoutSeg button').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        applyOverlayFromInputs();
      });
    });

    ['width', 'artSize', 'fontSize', 'radius', 'glow', 'bgOpacity'].forEach((id) => {
      $(id).addEventListener('input', applyOverlayFromInputs);
    });
    ['accent', 'accent2', 'textColor'].forEach((id) => {
      $(id).addEventListener('input', applyOverlayFromInputs);
    });
    ['showArtwork', 'showArtist', 'showAlbum', 'showTimes', 'showProgress', 'showLabel', 'transparent', 'animations'].forEach((id) => {
      $(id).addEventListener('change', applyOverlayFromInputs);
    });
    $('labelText').addEventListener('input', applyOverlayFromInputs);
    $('stopped').addEventListener('change', applyOverlayFromInputs);

    $('resetOverlay').addEventListener('click', () => {
      state.overlay = { ...DEFAULT_OVERLAY };
      fillOverlayInputs(state.overlay);
      api.updateOverlay(state.overlay);
      toast('Overlay settings reset.');
    });

    $('closeSettings').addEventListener('click', closeSettings);
    $('settingsModal').addEventListener('click', (e) => {
      if (e.target.dataset.close === '1') closeSettings();
    });
    $('openSettings').addEventListener('click', openSettings);
    $('openSettingsTop').addEventListener('click', openSettings);
    window.addEventListener('resize', fitPreview);
  }

  /* ---------------- wiring ---------------- */
  function bindUi() {
    $('addFiles').addEventListener('click', addFiles);
    $('addFolder').addEventListener('click', addFolder);
    $('clearQueue').addEventListener('click', () => {
      if (!state.queue.length) return;
      audio.pause();
      audio.removeAttribute('src');
      state.queue = [];
      state.index = -1;
      renderAll();
      pushPlayer(true);
      persist(true);
      toast('Playlist cleared.');
    });

    $('search').addEventListener('input', (e) => {
      filter = e.target.value;
      renderTracklist();
    });

    $('play').addEventListener('click', togglePlay);
    $('stop').addEventListener('click', stopPlayback);
    $('next').addEventListener('click', () => next(false));
    $('prev').addEventListener('click', prev);

    $('shuffle').addEventListener('click', () => {
      state.shuffle = !state.shuffle;
      renderTransport();
      persist();
    });

    $('repeat').addEventListener('click', () => {
      state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
      renderTransport();
      persist();
      toast(`Repeat: ${state.repeat}`);
    });

    $('mute').addEventListener('click', () => {
      state.muted = !state.muted;
      audio.muted = state.muted;
      renderTransport();
      persist();
    });

    $('volume').addEventListener('input', (e) => {
      const v = Number(e.target.value) / 100;
      state.volume = v;
      state.muted = false;
      audio.muted = false;
      audio.volume = v;
      $('volLabel').textContent = `${Math.round(v * 100)}%`;
      setFill(e.target, v * 100);
      renderTransport();
      persist();
    });

    $('seek').addEventListener('input', (e) => {
      const pct = Number(e.target.value) / 10;
      setFill(e.target, pct);
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (duration > 0) {
        audio.currentTime = (pct / 100) * duration;
        $('elapsed').textContent = fmt(audio.currentTime);
        pushPlayer(true);
      }
    });

    $('seek').addEventListener('change', () => persist());

    const copyUrl = async () => {
      await api.copyText(server.url);
      toast('Browser Source URL copied.');
    };
    $('copyUrl').addEventListener('click', copyUrl);
    $('copyUrl2').addEventListener('click', copyUrl);
    $('serverPill').addEventListener('click', copyUrl);
    $('openOverlay').addEventListener('click', () => api.openOverlay());

    // external file drops
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    window.addEventListener('drop', async (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const paths = [];
      for (const file of Array.from(e.dataTransfer.files)) {
        const p = api.pathForFile(file);
        if (p) paths.push(p);
      }
      await addPaths(paths);
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight' && e.ctrlKey) {
        e.preventDefault();
        next(false);
      } else if (e.key === 'ArrowLeft' && e.ctrlKey) {
        e.preventDefault();
        prev();
      } else if (e.key === 'ArrowRight') {
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
      } else if (e.key === 'ArrowLeft') {
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      } else if (e.key.toLowerCase() === 'm') {
        state.muted = !state.muted;
        audio.muted = state.muted;
        renderTransport();
        persist();
      } else if (e.key.toLowerCase() === 's') {
        state.shuffle = !state.shuffle;
        renderTransport();
        persist();
      } else if (e.key.toLowerCase() === 'r') {
        state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
        renderTransport();
        persist();
      } else if (e.key === 'Escape') {
        if ($('settingsModal').classList.contains('open')) closeSettings();
        else stopPlayback();
      }
    });

    window.addEventListener('beforeunload', () => persist(true));
  }

  async function pollHealth() {
    try {
      const res = await fetch(`${server.url.replace(/\/$/, '')}/health`, { cache: 'no-store' });
      const data = await res.json();
      $('ocClients').textContent = `${data.clients} connected`;
      $('serverPulse').classList.toggle('off', !data.ok);
    } catch {
      $('ocClients').textContent = 'server offline';
      $('serverPulse').classList.add('off');
    }
  }

  async function init() {
    const info = await api.init();
    server = info.server;

    const s = info.state;
    state.queue = Array.isArray(s.queue) ? s.queue : [];
    state.index = Number.isInteger(s.index) ? s.index : (state.queue.length ? 0 : -1);
    state.volume = Number.isFinite(s.volume) ? s.volume : 0.8;
    state.muted = Boolean(s.muted);
    state.shuffle = Boolean(s.shuffle);
    state.repeat = s.repeat || 'off';
    state.overlay = { ...DEFAULT_OVERLAY, ...(s.overlay || {}) };

    $('serverUrl').textContent = server.url;
    $('overlayUrl').textContent = server.url;
    $('previewFrame').src = server.url;

    audio.volume = state.volume;
    audio.muted = state.muted;
    $('volume').value = String(Math.round(state.volume * 100));
    $('volLabel').textContent = `${Math.round(state.volume * 100)}%`;
    setFill($('volume'), state.volume * 100);

    bindUi();
    bindSettings();
    fillOverlayInputs(state.overlay);

    if (state.queue.length && state.index >= 0) {
      const track = state.queue[state.index];
      audio.src = `${server.url.replace(/\/$/, '')}/audio/${track.id}`;
      audio.load();
      const saved = Number(s.position) || 0;
      if (saved > 0) {
        audio.addEventListener('loadedmetadata', () => {
          try {
            audio.currentTime = Math.min(saved, audio.duration || saved);
          } catch {
            /* ignore */
          }
          renderTimes();
        }, { once: true });
      }
    }

    renderAll();
    pushPlayer(true);
    pollHealth();
    setInterval(pollHealth, 5000);
  }

  init().catch((err) => {
    toast(`Startup failed: ${err.message}`, 'err');
    console.error(err);
  });
})();
