/* JAMB -- RoboTwin simulation gallery.

   One canvas stage fed by a single hidden <video>. The track-prediction clips
   are 640x240 files with ground truth baked into the left half and the
   prediction into the right, so both panes come off one decoder and are frame
   locked for free -- that is what makes the overlay exact rather than
   approximately synchronized.

   Overlay uses the 'darken' composite: the two halves render the same scene, so
   min() per channel leaves the shared background untouched and keeps whichever
   coloured track is present in either half. */
(function () {
  'use strict';

  var MANIFEST = 'data/sim_gallery.json';
  var SOURCE_ORDER = ['easy', 'hard', 'trackpred'];
  var SPEEDS = [0.5, 1, 2];
  /* Each half of a track-prediction clip carries a burned-in "GT track" /
     "Pred track" caption in its top band. Side by side keeps both, since each
     sits over its own pane; overlay shows only one pane's worth of top-left
     corner, so the caption band is cropped away there. */
  var LABEL_BAND = 28;

  var state = {
    data: null,
    source: 'easy',
    task: 0,
    clip: 0,
    mode: 'side',      // side | overlay
    speed: 1,
    scrubbing: false
  };

  var dom = {};
  var video = null;

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function task() { return state.data.tasks[state.task]; }
  function sourceMeta() { return state.data.sources[state.source]; }
  function clipsFor(t) { return (t.clips || {})[state.source] || []; }
  function clips() { return clipsFor(task()); }
  function clip() { return clips()[state.clip] || null; }
  function isSplit() { return !!sourceMeta().split; }

  function fmtTime(t) {
    if (!isFinite(t)) return '0:00';
    var s = Math.floor(t % 60);
    return Math.floor(t / 60) + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---------------------------------------------------------------- drawing

  /** Source-space geometry of one pane within the current clip. */
  function paneRect() {
    var c = clip();
    var w = c ? c.width : 320;
    var h = c ? c.height : 240;
    var cropped = isSplit() && state.mode !== 'side';
    return {
      w: isSplit() ? w / 2 : w,
      h: cropped ? h - LABEL_BAND : h,
      y: cropped ? LABEL_BAND : 0
    };
  }

  function layout() {
    var p = paneRect();
    var wide = isSplit() && state.mode === 'side';
    var cw = wide ? p.w * 2 : p.w;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cv = dom.canvas;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(p.h * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(p.h * dpr);
    }
    // the stage has a fixed height; the aspect ratio drives the width
    cv.style.aspectRatio = cw + ' / ' + p.h;
    return { cw: cw, ch: p.h, dpr: dpr, pane: p };
  }

  function draw() {
    requestAnimationFrame(draw);
    if (!video || video.readyState < 2) return;

    var L = layout();
    var ctx = dom.ctx;
    var p = L.pane;

    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, L.cw, L.ch);

    if (!isSplit()) {
      ctx.drawImage(video, 0, p.y, p.w, p.h, 0, 0, p.w, p.h);
      return;
    }

    if (state.mode === 'side') {
      ctx.drawImage(video, 0, p.y, p.w * 2, p.h, 0, 0, p.w * 2, p.h);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(p.w - 1, 0, 2, p.h);
      return;
    }

    ctx.drawImage(video, 0, p.y, p.w, p.h, 0, 0, p.w, p.h);         // GT
    ctx.globalCompositeOperation = 'darken';
    ctx.drawImage(video, p.w, p.y, p.w, p.h, 0, 0, p.w, p.h);       // Pred
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- loading

  function loadClip() {
    var c = clip();
    if (!c) return;
    video.src = c.src;
    video.playbackRate = state.speed;
    video.load();
    video.play().catch(function () { /* autoplay blocked; the button works */ });
    syncPlayButton();
  }

  function syncPlayButton() {
    var playing = video && !video.paused && !video.ended;
    dom.play.textContent = playing ? '❚❚' : '▶';
    dom.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  // ---------------------------------------------------------------- chrome

  function renderModes() {
    var split = isSplit();
    dom.modeRow.hidden = !split;
    if (!split) return;
    Array.prototype.forEach.call(dom.modeRow.children, function (b) {
      b.classList.toggle('is-active', b.dataset.mode === state.mode);
    });
  }

  function renderSources() {
    Array.prototype.forEach.call(dom.sourceRow.children, function (b) {
      b.classList.toggle('is-active', b.dataset.source === state.source);
    });
  }

  /* Only tasks with a clip in the current source get a tile -- in the Hard
     setting one task has no successful rollout at all, and an empty tile says
     nothing useful. */
  function renderRail() {
    dom.rail.innerHTML = '';
    state.data.tasks.forEach(function (t, i) {
      if (!clipsFor(t).length) return;

      var tile = el('button', 'rail-tile');
      tile.type = 'button';
      tile.classList.toggle('is-on', i === state.task);

      var media = el('div', 'rail-media');
      var v = el('video');
      v.muted = v.loop = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('preload', 'none');
      v.poster = t.poster[state.source];
      v.dataset.src = t.preview[state.source];
      media.appendChild(v);
      tile.addEventListener('mouseenter', function () {
        if (!v.src) v.src = v.dataset.src;
        v.play().catch(function () {});
      });
      tile.addEventListener('mouseleave', function () {
        v.pause();
        try { v.currentTime = 0; } catch (e) { /* not seekable yet */ }
      });
      tile.appendChild(media);

      tile.appendChild(el('span', 'rail-name', t.label));
      tile.appendChild(el('span', 'rail-group', t.group === 'sync' ? 'Sync' : 'Seq'));

      tile.addEventListener('click', function () {
        if (i === state.task) return;
        state.task = i;
        state.clip = 0;
        renderRail();
        renderPager();
        loadClip();
      });
      dom.rail.appendChild(tile);
    });
  }

  function renderPager() {
    var n = clips().length;
    dom.pager.hidden = n < 2;
    dom.pagerCount.textContent = (state.clip + 1) + ' / ' + n;
    dom.pagerPrev.disabled = state.clip === 0;
    dom.pagerNext.disabled = state.clip >= n - 1;
  }

  function step(delta) {
    var n = clips().length;
    var next = state.clip + delta;
    if (next < 0 || next >= n) return;
    state.clip = next;
    renderPager();
    loadClip();
  }

  function setSource(next) {
    if (next === state.source) return;
    state.source = next;
    state.clip = 0;
    if (!clips().length) {
      // the selected task has nothing in this source (Hard drops one task)
      var i = state.data.tasks.findIndex(function (t) {
        return (t.clips[next] || []).length > 0;
      });
      if (i >= 0) state.task = i;
    }
    if (!state.data.sources[next].split) state.mode = 'side';
    renderSources();
    renderModes();
    renderRail();
    renderPager();
    loadClip();
  }

  // ---------------------------------------------------------------- boot

  function build(host, data) {
    state.data = data;

    dom.sourceRow = el('div', 'segmented gallery-sources');
    SOURCE_ORDER.forEach(function (key) {
      if (!data.sources[key]) return;
      var b = el('button', null, data.sources[key].label);
      b.type = 'button';
      b.dataset.source = key;
      b.addEventListener('click', function () { setSource(key); });
      dom.sourceRow.appendChild(b);
    });

    dom.modeRow = el('div', 'segmented gallery-modes');
    [['side', 'Side by side'], ['overlay', 'Overlay']].forEach(function (m) {
      var b = el('button', null, m[1]);
      b.type = 'button';
      b.dataset.mode = m[0];
      b.addEventListener('click', function () {
        state.mode = m[0];
        renderModes();
      });
      dom.modeRow.appendChild(b);
    });

    var bar = el('div', 'gallery-bar');
    bar.appendChild(dom.sourceRow);
    bar.appendChild(dom.modeRow);

    dom.stage = el('div', 'gallery-stage');
    dom.canvas = el('canvas', 'gallery-canvas');
    dom.ctx = dom.canvas.getContext('2d');
    dom.stage.appendChild(dom.canvas);

    // transport: which rollout, then how it plays
    var transport = el('div', 'gallery-transport');

    dom.pager = el('div', 'gallery-pager');
    dom.pagerPrev = el('button', 'pager-btn', '←');
    dom.pagerPrev.type = 'button';
    dom.pagerPrev.setAttribute('aria-label', 'Previous rollout');
    dom.pagerPrev.addEventListener('click', function () { step(-1); });
    dom.pagerCount = el('span', 'pager-count', '1 / 1');
    dom.pagerNext = el('button', 'pager-btn', '→');
    dom.pagerNext.type = 'button';
    dom.pagerNext.setAttribute('aria-label', 'Next rollout');
    dom.pagerNext.addEventListener('click', function () { step(1); });
    dom.pager.appendChild(dom.pagerPrev);
    dom.pager.appendChild(dom.pagerCount);
    dom.pager.appendChild(dom.pagerNext);
    transport.appendChild(dom.pager);

    dom.play = el('button', 'transport-btn', '▶');
    dom.play.type = 'button';
    dom.play.addEventListener('click', function () {
      if (!video) return;
      if (video.paused) video.play().catch(function () {}); else video.pause();
      syncPlayButton();
    });
    transport.appendChild(dom.play);

    dom.seek = el('input', 'transport-seek');
    dom.seek.type = 'range';
    dom.seek.min = 0; dom.seek.max = 1000; dom.seek.step = 1; dom.seek.value = 0;
    dom.seek.setAttribute('aria-label', 'Seek');
    dom.seek.addEventListener('input', function () {
      if (!video || !isFinite(video.duration)) return;
      state.scrubbing = true;
      video.currentTime = (dom.seek.value / 1000) * video.duration;
    });
    dom.seek.addEventListener('change', function () { state.scrubbing = false; });
    transport.appendChild(dom.seek);

    dom.time = el('span', 'transport-time', '0:00');
    transport.appendChild(dom.time);

    dom.speed = el('button', 'transport-btn transport-speed', '1×');
    dom.speed.type = 'button';
    dom.speed.setAttribute('aria-label', 'Playback speed');
    dom.speed.addEventListener('click', function () {
      var i = (SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length;
      state.speed = SPEEDS[i];
      if (video) video.playbackRate = state.speed;
      dom.speed.textContent = state.speed + '×';
    });
    transport.appendChild(dom.speed);

    dom.rail = el('div', 'gallery-rail');

    host.innerHTML = '';
    host.appendChild(bar);
    host.appendChild(dom.stage);
    host.appendChild(transport);
    host.appendChild(dom.rail);

    video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('preload', 'auto');
    video.addEventListener('play', syncPlayButton);
    video.addEventListener('pause', syncPlayButton);
    video.addEventListener('timeupdate', function () {
      if (!isFinite(video.duration)) return;
      if (!state.scrubbing) {
        dom.seek.value = Math.round((video.currentTime / video.duration) * 1000);
      }
      dom.time.textContent = fmtTime(video.currentTime) + ' / '
        + fmtTime(video.duration);
    });

    renderSources();
    renderModes();
    renderRail();
    renderPager();
    loadClip();
    draw();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var host = document.getElementById('sim-gallery');
    if (!host) return;
    fetch(MANIFEST)
      .then(function (r) {
        if (!r.ok) throw new Error(MANIFEST + ' -> ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data.tasks || !data.tasks.length) throw new Error('empty manifest');
        build(host, data);
      })
      .catch(function (err) {
        console.warn('sim gallery', err);
        host.innerHTML = '';
        host.appendChild(el('div', 'loading',
          'Run tools/build_sim_gallery.py to transcode the RoboTwin clips into '
          + 'media/sim/ and regenerate data/sim_gallery.json.'));
      });
  });
})();
