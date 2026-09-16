/* The Track Theater.

   Reads the web bundles produced by tools/export_rollout.py and draws them in
   metric world space. The geometry mirrors XArm/scripts/vis/rollout_rerun.py:
   a strip per query, from the anchor through anchor + displacement; the point
   cloud unprojected from depth; the two end-effector paths taken from columns
   0:3 and 8:11 of the predicted action chunk.

   Orbit controls are written here rather than pulled in, since three.js ships
   OrbitControls only as an example module and this needs about sixty lines. */

import * as THREE from 'three';

const MOVE_THRESHOLD_M = 0.01;   // same criterion as rollout_rerun.py
const LEFT_EE = 0x35d0e8;
const RIGHT_EE = 0xc9a0ff;
const HOVER_COLOR = 0xffffff;

const dom = {};
const state = {
  manifest: null,
  taskId: null,
  bundle: null,
  step: 0,
  horizon: null,
  hover: -1,
  playing: false,
  layers: { pred: true, cloud: true, ee: true, anchors: false }
};
let playTimer = 0;
const PLAY_MS = 420;   // one prediction event per frame, slow enough to read
const cache = new Map();
const MAX_CACHE = 6;
const MAX_CLOUDS = 24;   // decoded point-cloud frames held per bundle

/* ------------------------------------------------------------------ data */

async function fetchBin(base, name, ver, Ctor) {
  const res = await fetch(base + '/' + name + ver);
  if (!res.ok) throw new Error(name + ' -> ' + res.status);
  return new Ctor(await res.arrayBuffer());
}

async function loadBundle(base, version) {
  /* Bundle paths are stable across re-exports, so without this a browser that
     already has cloud_12.bin keeps the previous export's copy. The stamp comes
     from build_manifest.py and changes whenever the bundle does. */
  const ver = version ? '?v=' + version : '';
  const key = base + ver;
  if (cache.has(key)) return cache.get(key);

  const metaRes = await fetch(base + '/meta.json' + ver);
  if (!metaRes.ok) throw new Error('meta.json -> ' + metaRes.status);
  const meta = await metaRes.json();

  const [tracks, valid, anchorsPx, actions] = await Promise.all([
    fetchBin(base, 'tracks.bin', ver, Int16Array),
    fetchBin(base, 'valid.bin', ver, Uint8Array),
    fetchBin(base, 'anchors_px.bin', ver, Float32Array),
    fetchBin(base, 'actions.bin', ver, Float32Array)
  ]);

  const bundle = {
    base, ver, meta, tracks, valid, anchorsPx, actions,
    clouds: new Map(), images: new Map()
  };
  bundle.bbox = anchorBBox(bundle);

  cache.set(key, bundle);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return bundle;
}

/** Dequantize one strip vertex into a THREE-ready triple. */
function stripPoint(bundle, buf, k, n, h, out) {
  const { N, strip_len } = bundle.meta;
  const q = bundle.meta.quant;
  const i = ((k * N + n) * strip_len + h) * 3;
  out[0] = buf[i] * q.scale + q.offset[0];
  out[1] = buf[i + 1] * q.scale + q.offset[1];
  out[2] = buf[i + 2] * q.scale + q.offset[2];
  return out;
}

/**
 * Where to point the camera: the box swept by the two predicted end-effector
 * paths, padded by roughly an arm's reach.
 *
 * Framing on the scene extent does not work. The head camera sees metres of
 * floor and background past the table, and enough of those far queries carry a
 * predicted displacement over the motion threshold that a motion-derived box
 * ends up as wide as the room. The end-effectors are always in the middle of
 * what matters, and they are tight and consistent across tasks.
 */
function eeBBox(bundle, pad) {
  const { K, H_a } = bundle.meta;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < K; k++) {
    for (let h = 0; h < H_a; h++) {
      const o = (k * H_a + h) * 16;
      for (const base of [o, o + 8]) {
        for (let a = 0; a < 3; a++) {
          const v = bundle.actions[base + a];
          if (!isFinite(v)) continue;
          if (v < lo[a]) lo[a] = v;
          if (v > hi[a]) hi[a] = v;
        }
      }
    }
  }
  if (!isFinite(lo[0])) return null;
  return {
    center: [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2),
    radius: Math.max(0.2, 0.5 * Math.hypot(
      hi[0] - lo[0] + 2 * pad, hi[1] - lo[1] + 2 * pad, hi[2] - lo[2] + 2 * pad))
  };
}

function anchorBBox(bundle) {
  const ee = eeBBox(bundle, 0.25);
  if (ee) return ee;

  // no usable action chunk: fall back to the exporter's workspace box, then
  // to a scan of the anchors
  const ws = bundle.meta.workspace;
  if (ws) {
    const center = [0, 1, 2].map((a) => (ws.min[a] + ws.max[a]) / 2);
    const radius = Math.max(0.15, 0.5 * Math.hypot(
      ws.max[0] - ws.min[0], ws.max[1] - ws.min[1], ws.max[2] - ws.min[2]));
    return { center, radius };
  }
  const { K, N } = bundle.meta;
  const p = [0, 0, 0];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < K; k++) {
    for (let n = 0; n < N; n++) {
      if (!bundle.valid[k * N + n]) continue;
      stripPoint(bundle, bundle.tracks, k, n, 0, p);
      for (let a = 0; a < 3; a++) {
        if (p[a] < lo[a]) lo[a] = p[a];
        if (p[a] > hi[a]) hi[a] = p[a];
      }
    }
  }
  if (!isFinite(lo[0])) return { center: [0, 0, 0], radius: 1 };
  const center = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  const radius = Math.max(
    0.15, 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
  return { center, radius };
}

async function loadCloud(bundle, k) {
  const events = bundle.meta.cloud_events || [];
  if (!events.length) return null;
  // nearest exported cloud, so --cloud-every still gives every step context
  let best = events[0];
  for (const e of events) if (Math.abs(e - k) < Math.abs(best - k)) best = e;
  if (bundle.clouds.has(best)) return bundle.clouds.get(best);

  const res = await fetch(bundle.base + '/cloud_' + best + '.bin' + bundle.ver);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const count = new Uint32Array(buf, 0, 2)[0];
  const xyz = new Int16Array(buf, 8, count * 3);
  const rgb = new Uint8Array(buf, 8 + count * 6, count * 3);

  const q = bundle.meta.quant;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = xyz[i * 3] * q.scale + q.offset[0];
    positions[i * 3 + 1] = xyz[i * 3 + 1] * q.scale + q.offset[1];
    positions[i * 3 + 2] = xyz[i * 3 + 2] * q.scale + q.offset[2];
    colors[i * 3] = rgb[i * 3] / 255;
    colors[i * 3 + 1] = rgb[i * 3 + 1] / 255;
    colors[i * 3 + 2] = rgb[i * 3 + 2] / 255;
  }
  const cloud = { positions, colors, count };
  bundle.clouds.set(best, cloud);
  /* At cloud_stride 1 a frame is ~45k points, about 1 MB of Float32 once
     decoded, and a long rollout has 70+ of them. Keep a sliding window
     instead of the whole rollout. */
  while (bundle.clouds.size > MAX_CLOUDS) {
    bundle.clouds.delete(bundle.clouds.keys().next().value);
  }
  return cloud;
}

function loadImage(bundle, k) {
  if (bundle.images.has(k)) return Promise.resolve(bundle.images.get(k));
  return new Promise((resolve) => {
    const img = new Image();
    const done = (value) => { bundle.images.set(k, value); resolve(value); };
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = bundle.base + '/obs_' + k + '.jpg' + bundle.ver;
  });
}

/* Pull every observation frame in the background as soon as a bundle is
   selected. Without this the first pass through the rollout goes
   frame -> blank -> frame at each step, because the canvas has to be cleared
   before an image that has not arrived yet. */
function prefetchImages(bundle) {
  for (let k = 0; k < bundle.meta.K; k++) loadImage(bundle, k);
}

/* ------------------------------------------------------------------ scene */

const gfx = {};

function initScene(canvas) {
  gfx.renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false
  });
  gfx.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // Nothing here is lit: point colours come straight from an sRGB camera frame
  // and line colours from the same ramp the CSS uses. Pass both through
  // untouched instead of round-tripping them through a linear working space,
  // which washes the wood grain out to grey.
  THREE.ColorManagement.enabled = false;
  gfx.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  gfx.scene = new THREE.Scene();
  gfx.scene.background = new THREE.Color(0x12151f);

  gfx.camera = new THREE.PerspectiveCamera(48, 1, 0.01, 60);
  gfx.camera.up.set(0, 0, 1);              // the rollouts use a Z-up world

  gfx.target = new THREE.Vector3();
  gfx.spherical = { radius: 1.4, theta: 2.6, phi: 1.0 };

  gfx.cloud = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ size: 0.004, vertexColors: true, sizeAttenuation: true })
  );
  gfx.scene.add(gfx.cloud);

  gfx.anchors = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ size: 0.006, color: 0x6b7280, sizeAttenuation: true })
  );
  gfx.scene.add(gfx.anchors);

  gfx.pred = makeSegments(true);
  gfx.scene.add(gfx.pred);

  gfx.eeLeft = makeLine(LEFT_EE);
  gfx.eeRight = makeLine(RIGHT_EE);
  // WebGL ignores line width, so a 16-step action chunk spanning a few
  // centimetres is a hairline. Markers on each predicted pose, sharing the
  // line's geometry, make the chunk readable.
  gfx.eeLeftPts = new THREE.Points(gfx.eeLeft.geometry,
    new THREE.PointsMaterial({ color: LEFT_EE, size: 0.011, sizeAttenuation: true }));
  gfx.eeRightPts = new THREE.Points(gfx.eeRight.geometry,
    new THREE.PointsMaterial({ color: RIGHT_EE, size: 0.011, sizeAttenuation: true }));
  gfx.eeLeftPts.frustumCulled = gfx.eeRightPts.frustumCulled = false;
  gfx.scene.add(gfx.eeLeft, gfx.eeRight, gfx.eeLeftPts, gfx.eeRightPts);

  gfx.highlight = makeSegments(false, HOVER_COLOR, 1);
  gfx.scene.add(gfx.highlight);

  gfx.raycaster = new THREE.Raycaster();
  gfx.raycaster.params.Points.threshold = 0.012;

  attachControls(canvas);
  window.addEventListener('resize', resize);
}

function makeSegments(vertexColors, color, width) {
  const geom = new THREE.BufferGeometry();
  const mat = new THREE.LineBasicMaterial(
    vertexColors ? { vertexColors: true, linewidth: width || 1 }
      : { color: color, linewidth: width || 1, transparent: true, opacity: 0.75 });
  const obj = new THREE.LineSegments(geom, mat);
  obj.frustumCulled = false;
  return obj;
}

function makeLine(color) {
  const obj = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color })
  );
  obj.frustumCulled = false;
  return obj;
}

function resize() {
  if (!gfx.renderer) return;
  const canvas = gfx.renderer.domElement;
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  gfx.renderer.setSize(w, h, false);
  gfx.camera.aspect = w / h;
  gfx.camera.updateProjectionMatrix();
  requestRender();
}

let renderPending = false;
function requestRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (!gfx.renderer) return;
    applyCamera();
    gfx.renderer.render(gfx.scene, gfx.camera);
  });
}

function applyCamera() {
  const s = gfx.spherical;
  s.phi = Math.max(0.05, Math.min(Math.PI - 0.05, s.phi));
  gfx.camera.position.set(
    gfx.target.x + s.radius * Math.sin(s.phi) * Math.cos(s.theta),
    gfx.target.y + s.radius * Math.sin(s.phi) * Math.sin(s.theta),
    gfx.target.z + s.radius * Math.cos(s.phi)
  );
  gfx.camera.lookAt(gfx.target);
}

function attachControls(canvas) {
  let dragging = null;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit';
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) { hover3d(e); return; }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dragging === 'orbit') {
      gfx.spherical.theta -= dx * 0.006;
      gfx.spherical.phi -= dy * 0.006;
    } else {
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      gfx.camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
      const k = gfx.spherical.radius * 0.0016;
      gfx.target.addScaledVector(right, -dx * k);
      gfx.target.addScaledVector(up, dy * k);
    }
    requestRender();
  });

  const end = (e) => {
    dragging = null;
    if (e.pointerId != null && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    gfx.spherical.radius *= Math.exp(e.deltaY * 0.0012);
    gfx.spherical.radius = Math.max(0.12, Math.min(12, gfx.spherical.radius));
    requestRender();
  }, { passive: false });
}

function frameScene(bundle) {
  const { center, radius } = bundle.bbox;
  gfx.target.set(center[0], center[1], center[2]);
  gfx.spherical.radius = radius * 1.7;
  gfx.spherical.theta = 2.6;      // three-quarter view from the camera side
  gfx.spherical.phi = 1.0;
  requestRender();
}

function setView(view) {
  // The rollouts use a Z-up world with x pointing away from the operator and
  // y running left-to-right between the two arms; theta is measured in the xy
  // plane from +x, so "front" sits on the camera's side of the table.
  const presets = {
    front: [Math.PI, 1.12],
    side: [-Math.PI / 2, 1.12],
    top: [Math.PI, 0.14]
  };
  if (view === 'reset') {
    if (state.bundle) frameScene(state.bundle);
    return;
  }
  const p = presets[view];
  if (!p) return;
  gfx.spherical.theta = p[0];
  gfx.spherical.phi = p[1];
  requestRender();
}

/* ------------------------------------------------------------ geometry fill */

/* tracks.bin can carry a display gain (meta.track_gain, applied by the
   exporter). Strip geometry wants the scaled values, but the moving/static
   split and the colour ramp are physical thresholds, so divide it back out. */
function trueDisplacement(bundle, k, n, a, b) {
  const { H_p } = bundle.meta;
  stripPoint(bundle, bundle.tracks, k, n, 0, a);
  stripPoint(bundle, bundle.tracks, k, n, H_p, b);
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return d / (bundle.meta.track_gain || 1);
}

function movingMask(bundle, k) {
  const { N } = bundle.meta;
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const mask = new Uint8Array(N);
  for (let n = 0; n < N; n++) {
    if (!bundle.valid[k * N + n]) continue;
    mask[n] = trueDisplacement(bundle, k, n, a, b) > MOVE_THRESHOLD_M ? 1 : 0;
  }
  return mask;
}

function fillSegments(obj, bundle, buf, k, horizon, mask, validBuf, colored) {
  const { N, H_p } = bundle.meta;
  const segs = Math.max(1, horizon);
  const positions = new Float32Array(N * segs * 2 * 3);
  const colors = colored ? new Float32Array(N * segs * 2 * 3) : null;
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  let v = 0;
  let drawn = 0;

  for (let n = 0; n < N; n++) {
    if (!mask[n]) continue;
    if (validBuf && !validBuf[k * N + n]) continue;
    drawn++;
    for (let h = 0; h < horizon; h++) {
      stripPoint(bundle, buf, k, n, h, p);
      stripPoint(bundle, buf, k, n, h + 1, q);
      positions[v * 3] = p[0];
      positions[v * 3 + 1] = p[1];
      positions[v * 3 + 2] = p[2];
      positions[v * 3 + 3] = q[0];
      positions[v * 3 + 4] = q[1];
      positions[v * 3 + 5] = q[2];
      if (colors) {
        const c0 = window.TrackColormap.ramp(h / H_p);
        const c1 = window.TrackColormap.ramp((h + 1) / H_p);
        colors[v * 3] = c0[0]; colors[v * 3 + 1] = c0[1]; colors[v * 3 + 2] = c0[2];
        colors[v * 3 + 3] = c1[0]; colors[v * 3 + 4] = c1[1]; colors[v * 3 + 5] = c1[2];
      }
      v += 2;
    }
  }

  const geom = obj.geometry;
  geom.setAttribute('position',
    new THREE.BufferAttribute(positions.subarray(0, v * 3), 3));
  if (colors) {
    geom.setAttribute('color',
      new THREE.BufferAttribute(colors.subarray(0, v * 3), 3));
  }
  geom.setDrawRange(0, v);
  geom.computeBoundingSphere();
  return drawn;
}

function fillAnchors(bundle, k, mask) {
  const { N } = bundle.meta;
  const positions = new Float32Array(N * 3);
  const p = [0, 0, 0];
  let v = 0;
  for (let n = 0; n < N; n++) {
    if (!bundle.valid[k * N + n] || mask[n]) continue;   // moving ones are strips
    stripPoint(bundle, bundle.tracks, k, n, 0, p);
    positions[v * 3] = p[0];
    positions[v * 3 + 1] = p[1];
    positions[v * 3 + 2] = p[2];
    v++;
  }
  gfx.anchors.geometry.setAttribute('position',
    new THREE.BufferAttribute(positions.subarray(0, v * 3), 3));
  gfx.anchors.geometry.setDrawRange(0, v);
  gfx.anchors.geometry.computeBoundingSphere();
  gfx.anchorIndex = null;
  return v;
}

/** A separate Points object carrying every valid anchor, used for 3D hover. */
function buildPickPoints(bundle, k) {
  const { N } = bundle.meta;
  const positions = new Float32Array(N * 3);
  const index = [];
  const p = [0, 0, 0];
  let v = 0;
  for (let n = 0; n < N; n++) {
    if (!bundle.valid[k * N + n]) continue;
    stripPoint(bundle, bundle.tracks, k, n, 0, p);
    positions[v * 3] = p[0];
    positions[v * 3 + 1] = p[1];
    positions[v * 3 + 2] = p[2];
    index.push(n);
    v++;
  }
  if (!gfx.pick) {
    gfx.pick = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 0.001, transparent: true, opacity: 0 })
    );
    gfx.pick.frustumCulled = false;
    gfx.scene.add(gfx.pick);
  }
  gfx.pick.geometry.setAttribute('position',
    new THREE.BufferAttribute(positions.subarray(0, v * 3), 3));
  gfx.pick.geometry.setDrawRange(0, v);
  gfx.pick.geometry.computeBoundingSphere();
  gfx.pickIndex = index;
}

function fillActions(bundle, k) {
  const { H_a } = bundle.meta;
  const stride = 16;
  const left = new Float32Array(H_a * 3);
  const right = new Float32Array(H_a * 3);
  for (let h = 0; h < H_a; h++) {
    const o = (k * H_a + h) * stride;
    left[h * 3] = bundle.actions[o];
    left[h * 3 + 1] = bundle.actions[o + 1];
    left[h * 3 + 2] = bundle.actions[o + 2];
    right[h * 3] = bundle.actions[o + 8];
    right[h * 3 + 1] = bundle.actions[o + 9];
    right[h * 3 + 2] = bundle.actions[o + 10];
  }
  gfx.eeLeft.geometry.setAttribute('position', new THREE.BufferAttribute(left, 3));
  gfx.eeRight.geometry.setAttribute('position', new THREE.BufferAttribute(right, 3));
  gfx.eeLeft.geometry.computeBoundingSphere();
  gfx.eeRight.geometry.computeBoundingSphere();
}

function fillHighlight(bundle, k, n) {
  const geom = gfx.highlight.geometry;
  if (n < 0) {
    geom.setDrawRange(0, 0);
    return;
  }
  const H = state.horizon;
  const positions = new Float32Array(Math.max(1, H) * 2 * 3);
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  let v = 0;
  for (let h = 0; h < H; h++) {
    stripPoint(bundle, bundle.tracks, k, n, h, p);
    stripPoint(bundle, bundle.tracks, k, n, h + 1, q);
    positions.set(p, v * 3);
    positions.set(q, v * 3 + 3);
    v += 2;
  }
  geom.setAttribute('position',
    new THREE.BufferAttribute(positions.subarray(0, v * 3), 3));
  geom.setDrawRange(0, v);
  geom.computeBoundingSphere();
}

/* ------------------------------------------------------------------ render */

function redraw() {
  const bundle = state.bundle;
  if (!bundle) return;
  const k = state.step;
  const mask = movingMask(bundle, k);

  fillSegments(gfx.pred, bundle, bundle.tracks, k,
    state.horizon, mask, bundle.valid, true);
  gfx.pred.visible = state.layers.pred;

  fillAnchors(bundle, k, mask);
  gfx.anchors.visible = state.layers.anchors;

  fillActions(bundle, k);
  gfx.eeLeft.visible = gfx.eeRight.visible = state.layers.ee;
  gfx.eeLeftPts.visible = gfx.eeRightPts.visible = state.layers.ee;

  buildPickPoints(bundle, k);
  fillHighlight(bundle, k, state.hover);
  gfx.highlight.visible = state.hover >= 0;

  gfx.cloud.visible = state.layers.cloud;
  if (state.layers.cloud) {
    loadCloud(bundle, k).then((cloud) => {
      if (!cloud || state.bundle !== bundle) return;
      gfx.cloud.geometry.setAttribute('position',
        new THREE.BufferAttribute(cloud.positions, 3));
      gfx.cloud.geometry.setAttribute('color',
        new THREE.BufferAttribute(cloud.colors, 3));
      gfx.cloud.geometry.computeBoundingSphere();
      gfx.cloud.material.size = 0.0019 * (bundle.meta.cloud_stride || 2);
      requestRender();
    });
  }

  drawObservation();
  requestRender();
}

function drawObservation() {
  const bundle = state.bundle;
  const canvas = dom.obsCanvas;
  if (!bundle || !canvas) return;
  const { width, height } = bundle.meta.image;
  // assigning either dimension clears the canvas, so only do it on a change
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const k = state.step;
  if (bundle.images.has(k)) {
    paintObservation(bundle, k, bundle.images.get(k));
    return;
  }
  // not cached yet: leave the previous frame up rather than blanking
  loadImage(bundle, k).then((img) => {
    if (state.bundle === bundle && state.step === k) {
      paintObservation(bundle, k, img);
    }
  });
}

function paintObservation(bundle, k, img) {
  const canvas = dom.obsCanvas;
  const { width, height } = bundle.meta.image;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, width, height);
  if (img) ctx.drawImage(img, 0, 0, width, height);
  else { ctx.fillStyle = '#012a4f'; ctx.fillRect(0, 0, width, height); }

  const { N } = bundle.meta;
  const mask = movingMask(bundle, k);
  const a = [0, 0, 0];
  const b = [0, 0, 0];

  for (let n = 0; n < N; n++) {
    if (!bundle.valid[k * N + n]) continue;
    const u = bundle.anchorsPx[(k * N + n) * 2];
    const v = bundle.anchorsPx[(k * N + n) * 2 + 1];
    if (!isFinite(u) || !isFinite(v)) continue;

    if (mask[n]) {
      const t = Math.min(1, trueDisplacement(bundle, k, n, a, b) / 0.12);
      ctx.fillStyle = window.TrackColormap.css(t);
      ctx.beginPath();
      ctx.arc(u, v, 2.1, 0, Math.PI * 2);
      ctx.fill();
    } else if (state.layers.anchors) {
      ctx.fillStyle = 'rgba(200,206,220,0.35)';
      ctx.fillRect(u - 0.6, v - 0.6, 1.2, 1.2);
    }
  }

  if (state.hover >= 0) {
    const u = bundle.anchorsPx[(k * N + state.hover) * 2];
    const v = bundle.anchorsPx[(k * N + state.hover) * 2 + 1];
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
  ctx.arc(u, v, 5, 0, Math.PI * 2);
  ctx.stroke();
  }
}

/* ------------------------------------------------------------------ hover */

function setHover(n) {
  if (state.hover === n) return;
  state.hover = n;
  if (state.bundle) {
    fillHighlight(state.bundle, state.step, state.hover);
    gfx.highlight.visible = state.hover >= 0;
    drawObservation();
    requestRender();
  }
}

function hoverObservation(event) {
  const bundle = state.bundle;
  if (!bundle) return;
  const rect = dom.obsCanvas.getBoundingClientRect();
  const sx = bundle.meta.image.width / rect.width;
  const sy = bundle.meta.image.height / rect.height;
  const x = (event.clientX - rect.left) * sx;
  const y = (event.clientY - rect.top) * sy;

  const { N } = bundle.meta;
  const k = state.step;
  let best = -1;
  let bestD = 7 * 7;
  for (let n = 0; n < N; n++) {
    if (!bundle.valid[k * N + n]) continue;
    const du = bundle.anchorsPx[(k * N + n) * 2] - x;
    const dv = bundle.anchorsPx[(k * N + n) * 2 + 1] - y;
    const d = du * du + dv * dv;
    if (d < bestD) { bestD = d; best = n; }
  }
  setHover(best);
}

function hover3d(event) {
  if (!state.bundle || !gfx.pick || !gfx.pickIndex) return;
  const canvas = gfx.renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  gfx.raycaster.setFromCamera(ndc, gfx.camera);
  const hits = gfx.raycaster.intersectObject(gfx.pick, false);
  setHover(hits.length ? gfx.pickIndex[hits[0].index] : -1);
}

/* ------------------------------------------------------------------ ui */

/* The viewer shows real-robot rollouts only; simulation lives in the
   video gallery, where ground truth is available to compare against. */
function domainEntry() {
  return state.manifest ? state.manifest.real : null;
}

function currentTask() {
  const d = domainEntry();
  if (!d) return null;
  return d.tasks.find((t) => t.id === state.taskId) || d.tasks[0] || null;
}

function refreshTaskOptions() {
  const d = domainEntry();
  dom.taskSelect.innerHTML = '';
  if (!d) return;
  d.tasks.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    dom.taskSelect.appendChild(opt);
  });
  if (!d.tasks.some((t) => t.id === state.taskId)) {
    state.taskId = d.tasks.length ? d.tasks[0].id : null;
  }
  dom.taskSelect.value = state.taskId || '';
}

/* Auto-advance through the rollout, for readers who would rather watch than
   drag. Stepping the existing scrubber keeps one source of truth. */
function setPlaying(on) {
  state.playing = on;
  dom.playBtn.classList.toggle('is-on', on);
  dom.playBtn.querySelector('.glyph').textContent = on ? '\u275A\u275A' : '\u25B6';
  dom.playBtn.setAttribute('aria-label', on ? 'Pause rollout' : 'Play rollout');
  clearInterval(playTimer);
  if (!on) return;
  playTimer = setInterval(() => {
    const b = state.bundle;
    if (!b) return;
    state.step = (state.step + 1) % b.meta.K;
    dom.stepSlider.value = String(state.step);
    state.hover = -1;
    updateScrubLabels();
    redraw();
  }, PLAY_MS);
}

function note(text) {
  dom.note.textContent = text || '';
  dom.note.style.display = text ? 'block' : 'none';
}

function showFallback(message, video) {
  dom.panes.style.display = 'none';
  dom.controls.style.display = 'none';
  dom.legend.style.display = 'none';
  let box = document.getElementById('theater-fallback');
  if (!box) {
    box = document.createElement('div');
    box.id = 'theater-fallback';
    box.className = 'theater-fallback';
    dom.theater.insertBefore(box, dom.note);
  }
  box.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = message;
  box.appendChild(p);
  if (video) {
    const v = document.createElement('video');
    v.src = video;
    v.controls = true;
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    box.appendChild(v);
  }
}

function hideFallback() {
  const box = document.getElementById('theater-fallback');
  if (box) box.remove();
  dom.panes.style.display = '';
  dom.controls.style.display = '';
  dom.legend.style.display = '';
}

async function selectRollout() {
  const task = currentTask();
  if (!task || !task.bundle) {
    showFallback('No rollout has been exported for this task yet.');
    note('');
    return;
  }
  hideFallback();
  note('Loading…');
  try {
    const bundle = await loadBundle('data/' + task.bundle, task.version);
    state.bundle = bundle;
    state.step = 0;
    state.horizon = bundle.meta.H_p;
    prefetchImages(bundle);
    state.hover = -1;

    dom.stepSlider.max = String(bundle.meta.K - 1);
    dom.stepSlider.value = '0';
    dom.horizonSlider.max = String(bundle.meta.H_p);
    dom.horizonSlider.value = String(bundle.meta.H_p);
    updateScrubLabels();

    note('');
    setPlaying(state.playing);

    frameScene(bundle);
    redraw();
  } catch (err) {
    console.warn(err);
    showFallback('That rollout bundle could not be loaded.');
    note('');
    setPlaying(false);
  }
}

function updateScrubLabels() {
  const b = state.bundle;
  if (!b) return;
  const t = b.meta.time_s && b.meta.time_s[state.step];
  dom.stepOut.textContent =
    `${state.step + 1} / ${b.meta.K}` + (t != null ? `  ·  ${t.toFixed(1)}s` : '');
  dom.horizonOut.textContent = `h = ${state.horizon} / ${b.meta.H_p}`;
}

function bindUI() {
  dom.playBtn.addEventListener('click', () => setPlaying(!state.playing));

  dom.taskSelect.addEventListener('change', () => {
    state.taskId = dom.taskSelect.value;
    selectRollout();
  });

  dom.stepSlider.addEventListener('input', () => {
    setPlaying(false);           // scrubbing takes over from playback
    state.step = parseInt(dom.stepSlider.value, 10);
    state.hover = -1;
    updateScrubLabels();
    redraw();
  });

  dom.horizonSlider.addEventListener('input', () => {
    state.horizon = parseInt(dom.horizonSlider.value, 10);
    updateScrubLabels();
    redraw();
  });

  dom.layerRow.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const layer = b.getAttribute('data-layer');
    state.layers[layer] = !state.layers[layer];
    b.classList.toggle('is-on', state.layers[layer]);
    redraw();
  });

  dom.camPresets.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setView(b.getAttribute('data-view'));
  });

  dom.obsCanvas.addEventListener('mousemove', hoverObservation);
  dom.obsCanvas.addEventListener('mouseleave', () => setHover(-1));
}

function boot(manifest) {
  dom.theater = document.getElementById('theater');
  if (!dom.theater) return;
  dom.taskSelect = document.getElementById('task-select');
  dom.playBtn = document.getElementById('play-btn');
  dom.stepSlider = document.getElementById('step-slider');
  dom.horizonSlider = document.getElementById('horizon-slider');
  dom.stepOut = document.getElementById('step-out');
  dom.horizonOut = document.getElementById('horizon-out');
  dom.layerRow = document.getElementById('layer-row');
  dom.camPresets = document.getElementById('cam-presets');
  dom.obsCanvas = document.getElementById('obs-canvas');
  dom.note = document.getElementById('theater-note');
  dom.panes = dom.theater.querySelector('.theater-panes');
  dom.controls = dom.theater.querySelector('.theater-controls');
  dom.legend = dom.theater.querySelector('.theater-legend');

  state.manifest = manifest;

  if (!manifest || !manifest.real || !manifest.real.tasks
      || !manifest.real.tasks.length) {
    showFallback('No rollout bundles are published yet. Run '
      + 'tools/export_rollout.py and tools/build_manifest.py to populate '
      + 'data/bundles.');
    note('');
    return;
  }

  const canvas = document.getElementById('scene-canvas');
  try {
    initScene(canvas);
  } catch (err) {
    console.warn('WebGL unavailable', err);
    showFallback('This browser could not start WebGL, so the 3D view is '
      + 'unavailable.');
    return;
  }

  refreshTaskOptions();
  bindUI();
  resize();
  selectRollout();
}

document.addEventListener('jamb:manifest', (e) => boot(e.detail));
if (window.JAMBManifest !== undefined) boot(window.JAMBManifest);
