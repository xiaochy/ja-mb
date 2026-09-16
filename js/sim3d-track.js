/* JAMB project page -- RoboTwin2.0 predicted-track 3D demos.

   Same rendering approach as the Real-World theater (js/track-viewer.js)
   in spirit, but reads the simpler per-episode bundle format produced by
   scripts/export_trackvis_binary.py (base64-encoded packed binary: a
   shared dense-point-cloud snapshot table + per-chunk predicted-track
   deltas from patch_centers) rather than the real-world quantized-cloud
   format -- sim tracks are noise-free and don't need the real pipeline's
   quantization/calibration metadata. */
(function () {
  'use strict';

  var MOVE_THRESH = 0.01;
  var SOURCE_FPS = 10;
  var root = document.getElementById('sim3d');
  if (!root) return;

  var taskSelect = document.getElementById('sim3d-task-select');
  var settingSeg = document.getElementById('sim3d-setting-seg');
  var grid = document.getElementById('sim3d-grid');
  var note = document.getElementById('sim3d-note');

  function reportError(msg) {
    if (note) note.textContent = 'sim3d failed to load: ' + msg;
    console.error('sim3d:', msg);
  }
  if (typeof THREE === 'undefined') { reportError('THREE failed to load from CDN'); return; }
  if (typeof THREE.OrbitControls === 'undefined') { reportError('THREE.OrbitControls failed to load from CDN'); return; }

  var manifest = null;
  var setting = 'easy';
  var activeViewers = [];
  var rampStops = null;
  var pendingIO = null;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function hexToRgb01(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return [1, 1, 0];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  }

  function globalTick(now) {
    /* All cards share this one rAF loop. If a single viewer's tick()
       throws (e.g. rendering before its geometry is populated), an
       uncaught exception here would skip the requestAnimationFrame
       call below and silently freeze every card on the page forever
       -- guard per-viewer so one bad tick can't kill the whole loop. */
    for (var i = 0; i < activeViewers.length; i++) {
      try { activeViewers[i].tick(now); } catch (e) { console.error('sim3d tick failed', e); }
    }
    requestAnimationFrame(globalTick);
  }
  requestAnimationFrame(globalTick);

  function parseTrackvisB64(b64) {
    var bin = atob(b64);
    var buf = new ArrayBuffer(bin.length);
    var bytes = new Uint8Array(buf);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var dv = new DataView(buf);
    var off = 0;
    var nC = dv.getUint32(off, true); off += 4;
    var nS = dv.getUint32(off, true); off += 4;
    var nD = dv.getUint32(off, true); off += 4;
    var nP = dv.getUint32(off, true); off += 4;
    var H = dv.getUint32(off, true); off += 4;

    var snapshots = [];
    for (var s = 0; s < nS; s++) {
      var xyz = new Float32Array(buf.slice(off, off + nD * 3 * 4)); off += nD * 3 * 4;
      var rgb = new Uint8Array(buf.slice(off, off + nD * 3)); off += nD * 3;
      snapshots.push({ xyz: xyz, rgb: rgb });
    }

    var chunks = [];
    var maxMag = MOVE_THRESH * 3;
    for (var c = 0; c < nC; c++) {
      var nFrames = dv.getUint32(off, true); off += 4;
      var snapshotIdx = dv.getUint32(off, true); off += 4;
      var patchCenters = new Float32Array(buf.slice(off, off + nP * 3 * 4)); off += nP * 3 * 4;
      var trackPred = new Float32Array(buf.slice(off, off + nP * H * 3 * 4)); off += nP * H * 3 * 4;

      var mag = new Float32Array(nP);
      for (var p = 0; p < nP; p++) {
        var base = (p * H + (H - 1)) * 3;
        var dx = trackPred[base], dy = trackPred[base + 1], dz = trackPred[base + 2];
        var m = Math.sqrt(dx * dx + dy * dy + dz * dz);
        mag[p] = m;
        if (m > maxMag) maxMag = m;
      }
      chunks.push({ nFrames: nFrames, snapshotIdx: snapshotIdx, patchCenters: patchCenters, trackPred: trackPred, mag: mag });
    }
    return { chunks: chunks, snapshots: snapshots, nDense: nD, nPatch: nP, horizon: H, globalMaxMag: maxMag };
  }

  function colorForMag(m, globalMaxMag) {
    var t = Math.max(0, Math.min(1, (m - MOVE_THRESH) / Math.max(globalMaxMag - MOVE_THRESH, 1e-6)));
    if (!rampStops) {
      rampStops = ['--t0', '--t1', '--t2', '--t3', '--t4'].map(function (v) { return hexToRgb01(cssVar(v)); });
    }
    var seg = t * (rampStops.length - 1);
    var i0 = Math.floor(seg), i1 = Math.min(i0 + 1, rampStops.length - 1);
    var f = seg - i0;
    var a = rampStops[i0], b = rampStops[i1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  function createViewer(canvasWrap, readoutEl) {
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.01, 100);
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x00274c, 1); /* matches --panel */
    canvasWrap.appendChild(renderer.domElement);

    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6;

    /* Give both geometries a valid (empty) position/color attribute up
       front, before they're added to the scene. The episode JSON loads
       async (fetch), so the shared rAF loop (see globalTick) will render
       this scene on frames that land before load() ever resolves -- an
       attribute-less BufferGeometry at that point throws inside
       WebGLRenderer, which (pre-try/catch) silently froze the loop for
       every card on the page forever. */
    function emptyAttr() { return new THREE.BufferAttribute(new Float32Array(0), 3); }

    var pointsGeom = new THREE.BufferGeometry();
    pointsGeom.setAttribute('position', emptyAttr());
    pointsGeom.setAttribute('color', emptyAttr());
    /* sizeAttenuation:false -> `size` is literal screen pixels, not world
       units scaled by camera distance. These cards are much smaller
       (~230px) than the standalone gallery this code was first tested in
       (~600px); at that size, world-unit sizeAttenuation shrank every
       point to sub-pixel (confirmed: an unconditional test sphere at the
       same world position rendered fine, only the Points geometry was
       invisible) -- fixed pixel size is robust to card size instead. */
    var pointsMat = new THREE.PointsMaterial({ size: 3, vertexColors: true, sizeAttenuation: false });
    var pointsObj = new THREE.Points(pointsGeom, pointsMat);
    /* frustumCulled needs geometry.boundingSphere, which three.js computes
       lazily and CACHES the first time it's needed -- since that first
       check can land while the geometry still holds the empty seed
       attribute above, it bakes in a zero-radius sphere at the origin
       that a later setAttribute() with real data does NOT invalidate.
       Every subsequent frame then culls the object as "outside the
       frustum" forever, even once real points are loaded (confirmed via
       direct instrumentation: boundingSphere stayed {radius:0} and
       frustum.intersectsObject() returned false indefinitely). These
       scenes are single small point clouds -- culling buys nothing, so
       just disable it instead of chasing recompute timing. */
    pointsObj.frustumCulled = false;
    scene.add(pointsObj);

    var trackGeom = new THREE.BufferGeometry();
    trackGeom.setAttribute('position', emptyAttr());
    trackGeom.setAttribute('color', emptyAttr());
    trackGeom.setDrawRange(0, 0);
    var trackMat = new THREE.LineBasicMaterial({ vertexColors: true });
    var trackLineObj = new THREE.LineSegments(trackGeom, trackMat);
    trackLineObj.frustumCulled = false;
    scene.add(trackLineObj);
    var trackDotsMat = new THREE.PointsMaterial({ size: 5, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.9 });
    var trackDotsObj = new THREE.Points(trackGeom, trackDotsMat);
    trackDotsObj.frustumCulled = false;
    scene.add(trackDotsObj);

    var chunks = [], snapshots = [], nDense = 0, nPatch = 0, horizon = 0, globalMaxMag = MOVE_THRESH * 3;
    var curIdx = -1, playing = true, elapsed = 0, totalSeconds = 0, lastT = performance.now();
    var disposed = false;

    function resize() {
      var w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    var resizeObs = new ResizeObserver(resize);
    resizeObs.observe(canvasWrap);

    function allocBuffers() {
      pointsGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nDense * 3), 3));
      pointsGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nDense * 3), 3));
      var maxTrackVerts = nPatch * horizon * 2;
      trackGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxTrackVerts * 3), 3));
      trackGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxTrackVerts * 3), 3));
      trackGeom.setDrawRange(0, 0);
    }

    function frameCamera() {
      var minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (var i = 0; i < snapshots.length; i++) {
        var s = snapshots[i];
        for (var p = 0; p < nDense; p++) {
          var x = s.xyz[p * 3], y = s.xyz[p * 3 + 1], z = s.xyz[p * 3 + 2];
          if (x === 0 && y === 0 && z === 0) continue;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
      var nonZero = isFinite(minX);
      var cx, cy, cz, half;
      if (!nonZero) {
        cx = 0; cy = 0; cz = 0; half = 0.5;
      } else {
        cx = (minX + maxX) / 2; cy = (minY + maxY) / 2; cz = (minZ + maxZ) / 2;
        half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2 * 1.15 || 0.3;
      }
      controls.target.set(cx, cy, cz);
      camera.up.set(0, 0, 1);
      camera.position.set(cx + half * 1.4, cy - half * 1.4, cz + half * 1.1);
      camera.lookAt(cx, cy, cz);
      controls.update();
    }

    function setChunk(idx) {
      var c = chunks[idx];
      var snap = snapshots[c.snapshotIdx];
      var posAttr = pointsGeom.getAttribute('position'), colAttr = pointsGeom.getAttribute('color');
      posAttr.array.set(snap.xyz);
      for (var i = 0; i < nDense * 3; i++) colAttr.array[i] = snap.rgb[i] / 255;
      posAttr.needsUpdate = true; colAttr.needsUpdate = true;

      var trackPos = trackGeom.getAttribute('position'), trackCol = trackGeom.getAttribute('color');
      var vtx = 0;
      for (var p = 0; p < nPatch; p++) {
        if (c.mag[p] <= MOVE_THRESH) continue;
        var rgb = colorForMag(c.mag[p], globalMaxMag);
        var pcx = c.patchCenters[p * 3], pcy = c.patchCenters[p * 3 + 1], pcz = c.patchCenters[p * 3 + 2];
        var prevX = pcx, prevY = pcy, prevZ = pcz;
        for (var h = 0; h < horizon; h++) {
          var base = (p * horizon + h) * 3;
          var x = pcx + c.trackPred[base], y = pcy + c.trackPred[base + 1], z = pcz + c.trackPred[base + 2];
          trackPos.array[vtx * 3] = prevX; trackPos.array[vtx * 3 + 1] = prevY; trackPos.array[vtx * 3 + 2] = prevZ;
          trackCol.array[vtx * 3] = rgb[0]; trackCol.array[vtx * 3 + 1] = rgb[1]; trackCol.array[vtx * 3 + 2] = rgb[2];
          vtx++;
          trackPos.array[vtx * 3] = x; trackPos.array[vtx * 3 + 1] = y; trackPos.array[vtx * 3 + 2] = z;
          trackCol.array[vtx * 3] = rgb[0]; trackCol.array[vtx * 3 + 1] = rgb[1]; trackCol.array[vtx * 3 + 2] = rgb[2];
          vtx++;
          prevX = x; prevY = y; prevZ = z;
        }
      }
      trackGeom.setDrawRange(0, vtx);
      trackPos.needsUpdate = true; trackCol.needsUpdate = true;
    }

    function idxForElapsed(t) {
      var acc = 0;
      for (var i = 0; i < chunks.length; i++) {
        acc += chunks[i].nFrames / SOURCE_FPS;
        if (t < acc) return i;
      }
      return chunks.length - 1;
    }

    function applyIdx(i) {
      if (i === curIdx) return;
      curIdx = i;
      setChunk(i);
      if (readoutEl) readoutEl.textContent = elapsed.toFixed(1) + 's / ' + totalSeconds.toFixed(1) + 's';
    }

    function tick(now) {
      var dt = (now - lastT) / 1000;
      lastT = now;
      if (playing && chunks.length) {
        elapsed += dt;
        if (elapsed >= totalSeconds) elapsed = 0; /* loop */
        applyIdx(idxForElapsed(elapsed));
      }
      controls.update();
      renderer.render(scene, camera);
    }

    function load(entry) {
      return fetch(entry.file).then(function (res) {
        if (!res.ok) throw new Error('fetch ' + entry.file + ' -> HTTP ' + res.status);
        return res.json();
      }).then(function (json) {
        /* The fetch outlives a task switch: by the time it lands this card
           may already be gone and its GL context released. Touching the
           geometry then throws inside three.js. */
        if (disposed) return;
        if (!json.b64) throw new Error(entry.file + ': no "b64" field');
        var parsed = parseTrackvisB64(json.b64);
        chunks = parsed.chunks; snapshots = parsed.snapshots; nDense = parsed.nDense; nPatch = parsed.nPatch;
        horizon = parsed.horizon; globalMaxMag = parsed.globalMaxMag;
        allocBuffers();
        resize();
        frameCamera();
        curIdx = -1; elapsed = 0;
        totalSeconds = chunks.reduce(function (s, c) { return s + c.nFrames / SOURCE_FPS; }, 0);
        applyIdx(0);
      });
    }

    /* A dropped canvas does NOT release its WebGL context when it is
       garbage-collected -- and GC is not deterministic anyway. Browsers cap
       live contexts (Chrome ~16), so four orphans per task switch means the
       browser starts force-losing contexts after a handful of switches and
       cards go black. Tear each one down explicitly on switch. */
    function dispose() {
      if (disposed) return;
      disposed = true;
      resizeObs.disconnect();
      controls.dispose();
      pointsGeom.dispose();
      trackGeom.dispose();
      pointsMat.dispose();
      trackMat.dispose();
      trackDotsMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    }

    activeViewers.push({ tick: tick, dispose: dispose });
    return { load: load };
  }

  function makeCard(ep) {
    var card = document.createElement('div');
    card.className = 'sim3d-card';
    var badgeClass = ep.outcome === 'success' ? 'is-success' : 'is-failure';
    card.innerHTML =
      '<div class="sim3d-card-head">' +
        '<span class="sim3d-badge ' + badgeClass + '">' + ep.outcome + '</span>' +
      '</div>' +
      '<div class="sim3d-canvas-wrap">' +
        '<div class="sim3d-loading">loading&hellip;</div>' +
      '</div>' +
      '<div class="sim3d-readout">0.0s</div>';
    return card;
  }

  function renderTask(taskEntry) {
    activeViewers.forEach(function (v) {
      try { v.dispose(); } catch (e) { console.error('sim3d dispose failed', e); }
    });
    activeViewers.length = 0;
    grid.innerHTML = '';
    if (!taskEntry || !taskEntry.episodes.length) {
      note.textContent = 'No episodes available for this task/setting.';
      return;
    }
    note.textContent = '';
    taskEntry.episodes.forEach(function (ep) {
      var card = makeCard(ep);
      grid.appendChild(card);
      var canvasWrap = card.querySelector('.sim3d-canvas-wrap');
      var loadingEl = card.querySelector('.sim3d-loading');
      var readoutEl = card.querySelector('.sim3d-readout');
      var viewer = createViewer(canvasWrap, readoutEl);
      viewer.load(ep).then(function () {
        loadingEl.style.display = 'none';
      }).catch(function (err) {
        loadingEl.textContent = 'failed: ' + (err && err.message ? err.message : String(err));
        console.error('sim3d episode failed:', ep, err);
      });
    });
  }

  function currentTaskEntry() {
    if (!manifest) return null;
    var task = taskSelect.value;
    return manifest.tasks.find(function (t) { return t.task === task && t.setting === setting; }) || null;
  }

  function refresh() {
    if (pendingIO) { pendingIO.disconnect(); pendingIO = null; }
    renderTask(currentTaskEntry());
  }

  function init(m) {
    manifest = m;
    var tasksInOrder = [];
    var seen = {};
    m.tasks.forEach(function (t) {
      if (!seen[t.task]) { seen[t.task] = true; tasksInOrder.push(t); }
    });
    taskSelect.innerHTML = '';
    tasksInOrder.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.task;
      opt.textContent = t.label;
      taskSelect.appendChild(opt);
    });
    taskSelect.addEventListener('change', refresh);
    settingSeg.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        settingSeg.querySelectorAll('button').forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        setting = btn.getAttribute('data-setting');
        refresh();
      });
    });

    /* One task view is 20-50 MB of episode JSON. Rendering on load spends
       that on every visitor, including the ones who never scroll this far --
       wait until the block is about to come into view. */
    pendingIO = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) { refresh(); return; }
      }
    }, { rootMargin: '300px 0px' });
    pendingIO.observe(root);
  }

  /* cache: 'no-store' -- manifest.json's episode list changes whenever the
     underlying data is re-collected (episode files get added/removed, not
     just edited in place). Without this, a browser that cached an older
     manifest keeps requesting episode files that no longer exist -> 404s
     on every card, even though the live data and code are both correct. */
  fetch('data/sim3d/manifest.json', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(init)
    .catch(function (err) {
      reportError(err && err.message ? err.message : String(err));
    });
})();
