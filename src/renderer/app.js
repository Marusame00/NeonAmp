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
    groups: [],
    upNext: [],
    index: -1,
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: 'off',
    sort: 'manual',
    ducking: { enabled: false, duckTo: 0.35, threshold: 45, deviceId: '' },
    overlay: { ...DEFAULT_OVERLAY }
  };

  const sortApi = window.NeonAmpSort;

  let server = { url: 'http://127.0.0.1:8765/' };
  let filter = '';
  let dragState = null;
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

  /* ---------------- voice ducking ---------------- */
  const DUCK_DEFAULTS = { enabled: false, duckTo: 0.35, threshold: 45, deviceId: '' };

  let duckGain = 1;
  let duckTimer = null;
  let duckLastTick = 0;
  let duckStream = null;
  let duckCtx = null;
  let duckAnalyser = null;
  let duckData = null;
  let duckLastVoiceAt = 0;
  let duckLoudTicks = 0;
  let duckCalibrating = null;

  function applyVolume() {
    audio.volume = Math.max(0, Math.min(1, state.volume * duckGain));
  }

  function duckLevelPct(rms) {
    return Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 60)) * 100;
  }

  function duckFail(message) {
    state.ducking.enabled = false;
    stopDuckStream();
    duckGain = 1;
    applyVolume();
    renderDuck();
    persist();
    toast(message, 'err');
  }

  function onDuckTrackEnded() {
    duckFail('Microphone disconnected — ducking off.');
  }

  function stopDuckStream() {
    if (duckStream) {
      for (const track of duckStream.getTracks()) {
        track.removeEventListener('ended', onDuckTrackEnded);
        track.stop();
      }
      duckStream = null;
    }
    if (duckCtx) {
      duckCtx.close().catch(() => {});
      duckCtx = null;
    }
    duckAnalyser = null;
    duckData = null;
    duckLoudTicks = 0;
  }

  async function startDuckMic() {
    if (duckStream) return true;
    const deviceId = state.ducking.deviceId;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: false
        }
      });
      duckStream = stream;
      duckCtx = new AudioContext();
      if (duckCtx.state === 'suspended') await duckCtx.resume();
      const source = duckCtx.createMediaStreamSource(stream);
      duckAnalyser = duckCtx.createAnalyser();
      duckAnalyser.fftSize = 1024;
      duckData = new Float32Array(duckAnalyser.fftSize);
      source.connect(duckAnalyser);
      for (const track of stream.getTracks()) track.addEventListener('ended', onDuckTrackEnded);
      ensureDuckLoop();
      refreshDuckDevices();
      return true;
    } catch (err) {
      duckFail(`Mic unavailable: ${(err && err.message) || err}`);
      return false;
    }
  }

  function ensureDuckLoop() {
    if (duckTimer) return;
    duckLastTick = performance.now();
    duckTimer = setInterval(duckTick, 20);
  }

  function maybeStopDuckLoop() {
    if (!duckTimer || duckStream || duckCalibrating || duckGain < 0.999) return;
    clearInterval(duckTimer);
    duckTimer = null;
    duckGain = 1;
    applyVolume();
    paintDuck(0, false);
  }

  function paintDuck(levelPct, voice) {
    const btn = $('duckBtn');
    const gain = duckGain.toFixed(3);
    if (btn.dataset.gain !== gain) btn.dataset.gain = gain;
    const level = levelPct.toFixed(1);
    if (btn.dataset.level !== level) btn.dataset.level = level;
    $('duckFill').style.width = `${levelPct}%`;
    $('duckPanel').classList.toggle('talking', Boolean(voice) && state.ducking.enabled);
  }

  function duckTick() {
    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0.001, (now - duckLastTick) / 1000));
    duckLastTick = now;

    let levelPct = 0;
    if (duckAnalyser && duckData) {
      duckAnalyser.getFloatTimeDomainData(duckData);
      let sum = 0;
      for (let i = 0; i < duckData.length; i += 1) sum += duckData[i] * duckData[i];
      levelPct = duckLevelPct(Math.sqrt(sum / duckData.length));
    }

    if (levelPct >= state.ducking.threshold) duckLoudTicks += 1;
    else duckLoudTicks = 0;
    const voice = duckLoudTicks >= 2;
    if (voice) duckLastVoiceAt = now;

    if (duckCalibrating) duckCollectSample(now, levelPct);

    const target = state.ducking.enabled && now - duckLastVoiceAt < 650 ? state.ducking.duckTo : 1;
    const tau = target < duckGain ? 0.08 : 0.6;
    const next = duckGain + (target - duckGain) * (1 - Math.exp(-dt / tau));
    const changed = Math.abs(next - duckGain) > 0.001;
    duckGain = next;
    if (changed) applyVolume();

    paintDuck(levelPct, voice);
    maybeStopDuckLoop();
  }

  function duckCollectSample(now, levelPct) {
    const elapsed = now - duckCalibrating.startedAt;
    if (elapsed > 300) duckCalibrating.samples.push(levelPct);
    const left = Math.max(0, Math.ceil((4000 - elapsed) / 1000));
    const label = `Listening… ${left}`;
    if ($('duckCalibrate').textContent !== label) $('duckCalibrate').textContent = label;
    if (elapsed >= 4000) finishDuckCalibration();
  }

  function finishDuckCalibration() {
    const cal = duckCalibrating;
    duckCalibrating = null;
    $('duckCalibrate').textContent = 'Calibrate';
    const samples = cal.samples.slice().sort((a, b) => a - b);
    const pick = (q) => samples[Math.min(samples.length - 1, Math.max(0, Math.round((samples.length - 1) * q)))] || 0;
    const speech = pick(0.8);
    const noise = pick(0.2);
    if (samples.length < 4 || speech - noise < 8) {
      toast("Couldn't hear you — check the mic and try again.", 'err');
    } else {
      state.ducking.threshold = Math.round(Math.min(95, Math.max(1, noise + (speech - noise) * 0.45)));
      if (!cal.wasEnabled) state.ducking.enabled = true;
      renderDuck();
      persist();
      toast(`Calibrated — sensitivity set to ${state.ducking.threshold}%.`);
    }
    if (state.ducking.enabled) {
      if (!duckStream) startDuckMic();
    } else {
      stopDuckStream();
    }
    maybeStopDuckLoop();
  }

  async function duckCalibrate() {
    if (duckCalibrating) return;
    const wasEnabled = state.ducking.enabled;
    if (!duckStream) {
      const ok = await startDuckMic();
      if (!ok) return;
    }
    duckCalibrating = { samples: [], startedAt: performance.now(), wasEnabled };
    $('duckCalibrate').textContent = 'Listening… 4';
    ensureDuckLoop();
  }

  async function refreshDuckDevices() {
    const sel = $('duckDevice');
    if (!sel) return;
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      devices = [];
    }
    const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
    const current = state.ducking.deviceId;
    sel.textContent = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'System default';
    sel.appendChild(def);
    inputs.forEach((device, i) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `Microphone ${i + 1}`;
      sel.appendChild(opt);
    });
    sel.value = inputs.some((d) => d.deviceId === current) ? current : '';
  }

  function renderDuck() {
    const btn = $('duckBtn');
    btn.setAttribute('aria-pressed', String(state.ducking.enabled));
    btn.dataset.gain = duckGain.toFixed(3);
    $('duckPanel').classList.remove('talking');
    $('duckOff').classList.toggle('hidden', state.ducking.enabled);
    const toPct = Math.round(state.ducking.duckTo * 100);
    $('duckTo').value = String(toPct);
    setFill($('duckTo'), toPct);
    $('duckToOut').textContent = `${toPct}%`;
    $('duckThreshold').value = String(state.ducking.threshold);
    setFill($('duckThreshold'), state.ducking.threshold);
    $('duckThresholdOut').textContent = `${state.ducking.threshold}%`;
    $('duckMarker').style.left = `${state.ducking.threshold}%`;
    if (!state.ducking.enabled) {
      $('duckFill').style.width = '0%';
      btn.dataset.level = '0.0';
    }
  }

  /* ---------------- persistence ---------------- */
  function persist(immediate = false) {
    const payload = {
      queue: state.queue,
      groups: state.groups,
      upNext: state.upNext,
      index: state.index,
      volume: state.volume,
      muted: state.muted,
      shuffle: state.shuffle,
      repeat: state.repeat,
      sort: state.sort,
      ducking: state.ducking,
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
  function sectionsFor() {
    const q = filter.trim().toLowerCase();
    const matches = (track) => {
      if (!q) return true;
      const hay = `${track.title} ${track.artist} ${track.album} ${track.path}`.toLowerCase();
      return hay.includes(q);
    };

    const sections = [];
    for (const group of state.groups) {
      const found = [];
      state.queue.forEach((track, index) => {
        if (track.groupId === group.id && matches(track)) found.push({ track, index });
      });
      const ordered = sortApi.sortTracks(found.map((f) => f.track), group.sort);
      const byTrack = new Map(found.map((f) => [f.track, f.index]));
      sections.push({
        group,
        sort: group.sort,
        rows: ordered.map((track) => ({ track, index: byTrack.get(track) }))
      });
    }

    const loose = [];
    state.queue.forEach((track, index) => {
      if (!track.groupId && matches(track)) loose.push({ track, index });
    });
    if (loose.length) {
      const ordered = sortApi.sortTracks(loose.map((f) => f.track), state.sort);
      const byTrack = new Map(loose.map((f) => [f.track, f.index]));
      sections.push({
        group: null,
        sort: state.sort,
        rows: ordered.map((track) => ({ track, index: byTrack.get(track) }))
      });
    }
    return sections;
  }

  function renderTracklist() {
    const list = $('tracklist');
    const sections = sectionsFor();
    const frag = document.createDocumentFragment();
    let shown = 0;
    let matched = 0;

    for (const section of sections) {
      if (!section.rows.length) continue;
      if (section.group) frag.appendChild(buildGroupHeader(section));
      if (section.group && section.group.collapsed) continue;
      matched += section.rows.length;
      for (const row of section.rows) {
        if (shown >= 1000) break;
        frag.appendChild(buildTrackRow(row.track, row.index, section.sort));
        shown += 1;
      }
    }

    list.innerHTML = '';
    list.appendChild(frag);
    $('emptyState').hidden = state.queue.length > 0;
    list.hidden = state.queue.length === 0;
    $('trackCount').textContent = String(state.queue.length);
    $('totalTime').textContent = fmt(state.queue.reduce((sum, t) => sum + (t.duration || 0), 0));
    const anyManual = sections.some((s) => s.sort === 'manual' && s.rows.length);
    $('dragHint').textContent = anyManual ? 'drag rows to reorder' : 'sorted — set Manual to drag';
    if (matched > shown) {
      const note = document.createElement('div');
      note.className = 'panel-foot';
      note.textContent = `Showing first ${shown} of ${matched} matches — refine the filter.`;
      list.appendChild(note);
    }
  }

  function buildGroupHeader(section) {
    const group = section.group;
    const head = document.createElement('div');
    head.className = 'group-head';
    head.dataset.group = group.id;

    const chevron = document.createElement('button');
    chevron.className = 'group-chevron';
    chevron.type = 'button';
    chevron.title = group.collapsed ? 'Expand album' : 'Collapse album';
    chevron.setAttribute('aria-expanded', String(!group.collapsed));
    chevron.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
    if (group.collapsed) chevron.classList.add('collapsed');
    chevron.addEventListener('click', () => {
      group.collapsed = !group.collapsed;
      renderTracklist();
      persist();
    });

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group.name;
    name.title = `${group.path || group.name} — double-click to rename`;
    name.addEventListener('dblclick', () => startRename(head, group, name));

    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(section.rows.length);

    const sortSel = document.createElement('select');
    sortSel.className = 'sort-select group-sort';
    sortSel.title = 'Sort order for this album';
    for (const mode of sortApi.SORT_MODES) {
      const opt = document.createElement('option');
      opt.value = mode;
      opt.textContent = sortApi.SORT_LABELS[mode] || mode;
      sortSel.appendChild(opt);
    }
    sortSel.value = group.sort;
    sortSel.addEventListener('change', () => {
      group.sort = sortSel.value;
      renderTracklist();
      persist();
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'group-btn';
    renameBtn.type = 'button';
    renameBtn.title = 'Rename album';
    renameBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/></svg>';
    renameBtn.addEventListener('click', () => startRename(head, group, name));

    const removeBtn = document.createElement('button');
    removeBtn.className = 'group-btn danger';
    removeBtn.type = 'button';
    removeBtn.title = 'Remove album and its tracks';
    removeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';
    removeBtn.addEventListener('click', () => removeGroup(group.id));

    head.append(chevron, name, count, sortSel, renameBtn, removeBtn);
    return head;
  }

  function startRename(head, group, nameEl) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-rename';
    input.value = group.name;
    input.maxLength = 120;
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== group.name) {
        group.name = value;
        persist(true);
      }
      renderTracklist();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commit(false);
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
  }

  function removeGroup(groupId) {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return;
    const doomed = state.queue.filter((t) => t.groupId === groupId);
    const playing = currentTrack();
    const playingRemoved = playing && playing.groupId === groupId;

    state.queue = state.queue.filter((t) => t.groupId !== groupId);
    state.groups = state.groups.filter((g) => g.id !== groupId);

    if (playingRemoved) {
      audio.pause();
      audio.removeAttribute('src');
      state.index = state.queue.length ? 0 : -1;
      pushPlayer(true);
    } else if (state.index >= state.queue.length) {
      state.index = state.queue.length ? state.queue.length - 1 : -1;
    }

    renderAll();
    persist(true);
    toast(`Removed “${group.name}” (${doomed.length} track${doomed.length === 1 ? '' : 's'}).`);
  }

  function buildTrackRow(track, index, sortMode) {
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

    const addBtn = document.createElement('button');
    addBtn.className = 'row-add';
    addBtn.type = 'button';
    addBtn.title = 'Add to queue';
    addBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      queueAdd(track.id);
      toast(`Queued “${track.title}”.`);
    });

    row.append(idx, thumb, meta, addBtn, dur, eq);
    row.addEventListener('dblclick', () => playIndex(index));
    row.addEventListener('click', () => selectIndex(index, false));

    row.addEventListener('dragstart', (e) => {
      dragState = { kind: 'playlist', from: index, id: track.id };
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', String(index));
      } catch {
        /* ignore */
      }
    });
    row.addEventListener('dragend', () => {
      dragState = null;
      row.classList.remove('dragging');
      clearDropMarks();
    });

    if (sortMode === 'manual') {
      row.addEventListener('dragover', (e) => {
        if (!dragState || dragState.kind !== 'playlist') return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        clearDropMarks();
        row.classList.add(after ? 'drop-after' : 'drop-before');
      });
      row.addEventListener('drop', (e) => {
        if (!dragState || dragState.kind !== 'playlist') return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        moveTrack(dragState.from, index, after);
        clearDropMarks();
        dragState = null;
      });
    }

    return row;
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

  function trackById(id) {
    return state.queue.find((t) => t.id === id) || null;
  }

  function queueAdd(id, at = null) {
    if (!trackById(id)) return;
    if (at === null || at > state.upNext.length) state.upNext.push(id);
    else state.upNext.splice(Math.max(0, at), 0, id);
    renderUpNext();
    persist();
  }

  function queueRemoveAt(position) {
    if (position < 0 || position >= state.upNext.length) return;
    state.upNext.splice(position, 1);
    renderUpNext();
    persist();
  }

  function queueMove(from, to) {
    if (from === to || from < 0 || from >= state.upNext.length) return;
    const [id] = state.upNext.splice(from, 1);
    const target = Math.max(0, Math.min(state.upNext.length, to > from ? to - 1 : to));
    state.upNext.splice(target, 0, id);
    renderUpNext();
    persist();
  }

  function queueClear() {
    if (!state.upNext.length) return;
    state.upNext = [];
    renderUpNext();
    persist(true);
    toast('Queue cleared.');
  }

  function renderUpNext() {
    const list = $('unList');
    const wrap = $('upnext');
    list.innerHTML = '';

    const ids = state.upNext.filter((id) => trackById(id));
    if (ids.length !== state.upNext.length) state.upNext = ids;

    $('unCount').textContent = ids.length ? `${ids.length} queued` : 'empty';
    $('clearQueueBtn').hidden = ids.length === 0;

    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'un-empty';
      empty.textContent = 'Queue is empty — drag a track here, or use + on a row.';
      list.appendChild(empty);
      return;
    }

    ids.forEach((id, position) => {
      const track = trackById(id);
      const row = document.createElement('div');
      row.className = 'un-row';
      row.draggable = true;
      row.dataset.pos = String(position);

      const idx = document.createElement('span');
      idx.className = 'un-idx';
      idx.textContent = String(position + 1).padStart(2, '0');

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

      const playBtn = document.createElement('button');
      playBtn.className = 'group-btn';
      playBtn.type = 'button';
      playBtn.title = 'Play this now';
      playBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>';
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.upNext.splice(position, 1);
        playIndex(state.queue.indexOf(track));
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'group-btn danger';
      removeBtn.type = 'button';
      removeBtn.title = 'Remove from queue';
      removeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        queueRemoveAt(position);
      });

      row.append(idx, title, dur, playBtn, removeBtn);
      row.addEventListener('dblclick', () => {
        state.upNext.splice(position, 1);
        playIndex(state.queue.indexOf(track));
      });

      row.addEventListener('dragstart', (e) => {
        dragState = { kind: 'queue', from: position };
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', String(position));
        } catch {
          /* ignore */
        }
      });
      row.addEventListener('dragend', () => {
        dragState = null;
        row.classList.remove('dragging');
        clearDropMarks();
      });
      row.addEventListener('dragover', (e) => {
        if (!dragState) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        clearDropMarks();
        row.classList.add(after ? 'drop-after' : 'drop-before');
      });
      row.addEventListener('drop', (e) => {
        if (!dragState) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        const to = position + (after ? 1 : 0);
        if (dragState.kind === 'queue') queueMove(dragState.from, to);
        else if (dragState.kind === 'playlist') queueAdd(dragState.id, to);
        clearDropMarks();
        dragState = null;
      });

      list.appendChild(row);
    });
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
    // An explicit queue always wins over playlist order.
    while (state.upNext.length) {
      const id = state.upNext.shift();
      const index = state.queue.findIndex((t) => t.id === id);
      if (index >= 0) {
        loadTrack(index, true);
        return;
      }
    }
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
    const moving = state.queue[from];
    const targetTrack = state.queue[to];
    if (!moving || !targetTrack) return;
    // Reordering only makes sense inside one album; cross-album drops are ignored.
    if ((moving.groupId || null) !== (targetTrack.groupId || null)) return;

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
  async function addPaths(paths, groupId = null) {
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

    toast(`Reading ${fresh.length} file${fresh.length === 1 ? '' : 's'}...`);
    const inspected = await api.inspect(fresh);
    const valid = inspected.filter(Boolean);
    if (!valid.length) {
      toast('No supported audio files found.', 'err');
      return;
    }
    for (const track of valid) track.groupId = groupId;
    state.queue.push(...valid);
    if (state.index < 0) state.index = 0;
    renderAll();
    persist(true);
    const bad = valid.filter((t) => t.error).length;
    toast(`Added ${valid.length} track${valid.length === 1 ? '' : 's'}${bad ? ` (${bad} unreadable)` : ''}.`);
  }

  async function addFiles() {
    const paths = await api.addFiles();
    await addPaths(paths, null);
  }

  async function addFolder() {
    const result = await api.addFolder();
    const paths = Array.isArray(result) ? result : (result && result.files) || [];
    const folderPath = (result && result.folder) || '';
    if (!paths.length) {
      toast('No MP3 or WAV files in that folder.', 'err');
      return;
    }

    const name = folderPath
      ? folderPath.split(/[\\/]/).filter(Boolean).pop() || 'Untitled album'
      : 'Untitled album';

    const group = {
      id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      path: folderPath,
      sort: state.sort === 'manual' ? 'filename' : state.sort,
      collapsed: false
    };
    state.groups.push(group);

    await addPaths(paths, group.id);

    if (!state.queue.some((t) => t.groupId === group.id)) {
      state.groups = state.groups.filter((g) => g.id !== group.id);
      renderAll();
      persist(true);
      return;
    }
    renderAll();
    persist(true);
    toast(`Added album “${name}”. Double-click its name to rename.`);
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
    $('clearQueueBtn').addEventListener('click', queueClear);

    // Dropping anywhere on the queue panel appends to the end.
    const queuePanel = $('upnext');
    queuePanel.addEventListener('dragover', (e) => {
      if (!dragState) return;
      e.preventDefault();
      queuePanel.classList.add('drop-target');
    });
    queuePanel.addEventListener('dragleave', (e) => {
      if (!queuePanel.contains(e.relatedTarget)) queuePanel.classList.remove('drop-target');
    });
    queuePanel.addEventListener('drop', (e) => {
      queuePanel.classList.remove('drop-target');
      if (!dragState) return;
      e.preventDefault();
      if (dragState.kind === 'playlist') queueAdd(dragState.id, null);
      clearDropMarks();
      dragState = null;
    });

    $('clearQueue').addEventListener('click', () => {
      if (!state.queue.length) return;
      audio.pause();
      audio.removeAttribute('src');
      state.queue = [];
      state.groups = [];
      state.upNext = [];
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

    $('globalSort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      renderTracklist();
      persist(true);
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
      applyVolume();
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

    $('duckBtn').addEventListener('click', () => {
      state.ducking.enabled = !state.ducking.enabled;
      renderDuck();
      persist();
      if (state.ducking.enabled) startDuckMic();
      else stopDuckStream();
    });

    $('duckMore').addEventListener('click', () => {
      const panel = $('duckPanel');
      panel.classList.toggle('hidden');
      $('duckMore').setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
      if (!panel.classList.contains('hidden')) refreshDuckDevices();
    });

    $('duckCalibrate').addEventListener('click', () => {
      duckCalibrate();
    });

    $('duckTo').addEventListener('input', (e) => {
      state.ducking.duckTo = Number(e.target.value) / 100;
      $('duckToOut').textContent = `${Math.round(state.ducking.duckTo * 100)}%`;
      setFill(e.target, state.ducking.duckTo * 100);
      applyVolume();
      persist();
    });

    $('duckThreshold').addEventListener('input', (e) => {
      state.ducking.threshold = Number(e.target.value);
      $('duckThresholdOut').textContent = `${state.ducking.threshold}%`;
      setFill(e.target, state.ducking.threshold);
      $('duckMarker').style.left = `${state.ducking.threshold}%`;
      persist();
    });

    $('duckDevice').addEventListener('change', (e) => {
      state.ducking.deviceId = e.target.value;
      persist();
      if (state.ducking.enabled) {
        stopDuckStream();
        startDuckMic();
      }
    });

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
    state.groups = Array.isArray(s.groups) ? s.groups : [];
    state.upNext = Array.isArray(s.upNext) ? s.upNext : [];
    state.sort = sortApi.SORT_MODES.includes(s.sort) ? s.sort : 'manual';
    state.index = Number.isInteger(s.index) ? s.index : (state.queue.length ? 0 : -1);
    state.volume = Number.isFinite(s.volume) ? s.volume : 0.8;
    state.muted = Boolean(s.muted);
    state.shuffle = Boolean(s.shuffle);
    state.repeat = s.repeat || 'off';
    const d = s.ducking || {};
    state.ducking = {
      enabled: Boolean(d.enabled),
      duckTo: Number.isFinite(d.duckTo) ? Math.min(0.9, Math.max(0.05, d.duckTo)) : DUCK_DEFAULTS.duckTo,
      threshold: Number.isFinite(d.threshold) ? Math.min(95, Math.max(1, Math.round(d.threshold))) : DUCK_DEFAULTS.threshold,
      deviceId: typeof d.deviceId === 'string' ? d.deviceId : DUCK_DEFAULTS.deviceId
    };
    state.overlay = { ...DEFAULT_OVERLAY, ...(s.overlay || {}) };

    $('serverUrl').textContent = server.url;
    $('overlayUrl').textContent = server.url;
    $('previewFrame').src = server.url;

    applyVolume();
    audio.muted = state.muted;
    $('volume').value = String(Math.round(state.volume * 100));
    $('volLabel').textContent = `${Math.round(state.volume * 100)}%`;
    setFill($('volume'), state.volume * 100);
    $('globalSort').value = state.sort;

    bindUi();
    bindSettings();
    fillOverlayInputs(state.overlay);
    renderDuck();
    refreshDuckDevices();
    if (state.ducking.enabled) startDuckMic();

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
