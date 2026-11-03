/* Public 3D model viewer for /<project>/<revision>.
 *
 * One SPA serves every project and revision: CloudFront rewrites both share-URL
 * shapes to this page, so the project and revision are read back out of
 * location.pathname. Everything else comes from two small JSON objects that the
 * publish pipeline writes — /projects/<slug>.json (title, revision list) and
 * /comments/<slug>/<rev>.json (the feedback thread).
 *
 * Vanilla ES modules, no build step; three.js is self-hosted under vendor/ and
 * resolved through the import map in index.html.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { TrackballControls } from 'three/addons/TrackballControls.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';
import {
  cameraToView,
  describeView,
  directionToAzEl,
  formatViewFragment,
  formatViewToken,
  parseView,
  splitViewTokens,
  toModel,
  viewToCamera,
} from './viewref.js';

// --- tiny DOM helpers --------------------------------------------------------

const el = (id) => document.getElementById(id);
const show = (node) => node.classList.remove('hidden');
const hide = (node) => node.classList.add('hidden');

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function fmtBytes(n) {
  if (!n) return '';
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/**
 * The viewer's lifecycle, for anything driving the page rather than looking at it
 * (the MCP server's render_view): 'loading', then 'ready' once the model is
 * framed, the parts panel built, the URL's view applied and a frame drawn — or
 * 'error', with the reason in #errorTitle / #errorText.
 */
function setViewerState(state) {
  document.documentElement.dataset.viewerState = state;
}

function fail(title, message) {
  setViewerState('error');
  el('errorTitle').textContent = title;
  el('errorText').textContent = message;
  hide(el('loading'));
  show(el('error'));
}

// --- routing ----------------------------------------------------------------

/**
 * Read the project slug and (optional) revision out of the path. The CloudFront
 * function has already lowercased the slug, but a direct origin request or a
 * client-side history entry may not have, so normalize here too.
 */
function parsePath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return { slug: null, rev: null };
  const slug = decodeURIComponent(parts[0]).toLowerCase();
  const rev = parts[1] && /^[0-9]+$/.test(parts[1]) ? Number(parts[1]) : null;
  return { slug, rev };
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  // Read the body even when the status is bad: an unconsumed body leaves the
  // request in flight and blocks reuse of the connection. A missing object comes
  // back as the HTML 404 page, so a parse failure is also a "no" here.
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body: null };
  try {
    return { ok: true, status: res.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, body: null };
  }
}

// --- scene ------------------------------------------------------------------

const canvas = el('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// Capping the pixel ratio keeps the framebuffer small enough for iOS Safari,
// which kills the tab (rather than degrading) when GPU memory runs out.
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.NeutralToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
// A trackball, not an orbit: OrbitControls keeps the camera's up fixed and stops
// dead at the poles, so a view just past straight-down was unreachable without
// swinging the whole way round. A trackball tumbles in any direction; the
// navigation cube and Reset put the model back upright.
const controls = new TrackballControls(camera, renderer.domElement);
controls.rotateSpeed = 2.0;
controls.panSpeed = 0.8;
controls.dynamicDampingFactor = 0.15;
// Its A/S/D drag-mode keys listen on window, so typing a comment would switch
// what the next drag does.
controls.keys = ['', '', ''];

let needsRender = true;
const requestRender = () => {
  needsRender = true;
};
// The camera state the last frame was drawn from. TrackballControls only
// announces position changes, so a pure roll or a programmatic move is caught by
// comparing against this instead of trusting its 'change' event alone.
const lastDrawn = { position: new THREE.Vector3(NaN, 0, 0), quaternion: new THREE.Quaternion() };
controls.addEventListener('change', requestRender);

/** The navigation cube; null in bare mode. Created in main(), see createViewCube(). */
let viewCube = null;

function applyTheme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  scene.background = new THREE.Color(dark ? 0x14161a : 0xf2f3f5);
  viewCube?.retheme();
  requestRender();
}
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// A room environment gives untextured CAD parts believable shading without
// hand-placed lights; metallic materials would render black with lights alone.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
// A single directional light adds the shading gradient that reads as "solid".
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(1, 2, 1.5);
scene.add(keyLight);

function resize() {
  const stage = el('stage');
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  // The trackball caches the canvas rectangle for its pointer maths.
  controls.handleResize();
  viewCube?.resize();
  requestRender();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// Losing the WebGL context is a real outcome on mobile (backgrounding the tab
// with a large model); say so instead of showing a frozen frame.
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  fail('Display interrupted', 'The 3D view ran out of graphics memory. Reload the page to try again.');
});

/** Bounding-sphere centre and framing distance: what a view's zoom and pan are relative to. */
let frame = null;

/**
 * Frame the whole model, whatever its units. FreeCAD exports millimetres, so a
 * fixed camera distance would put a 30 mm clip either off-screen or inside the
 * near plane; everything here is derived from the bounding sphere instead.
 */
function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-4);
  const center = sphere.center;

  const fov = (camera.fov * Math.PI) / 180;
  const distance = (radius / Math.sin(fov / 2)) * 1.25;

  // Zoom-out room for a tumbled view, whose far side is further than framing's.
  camera.near = Math.max(radius / 1000, 1e-4);
  camera.far = distance * 8 + radius * 10;
  camera.updateProjectionMatrix();
  controls.minDistance = radius * 0.05;
  controls.maxDistance = distance * 8;

  frame = { center: center.clone(), radius, distance };
  applyView(HOME_VIEW, { animate: false });
}

/**
 * The opening three-quarter view, which reads as 3D immediately where a face-on
 * view would not. In model axes this is the camera at (1, -1, 0.6): front-right,
 * a little above.
 */
const HOME_VIEW = { az: 45, el: 23, zoom: 1, roll: 0, pan: { x: 0, y: 0, z: 0 }, parts: null };

function resetView() {
  if (frame) applyView(HOME_VIEW, { animate: true });
}

// --- moving the camera -------------------------------------------------------

/** Where the camera is looking from, in view-reference terms (see viewref.js). */
function captureView() {
  const view = cameraToView({
    position: camera.position,
    target: controls.target,
    up: camera.up,
    center: frame.center,
    homeDistance: frame.distance,
  });
  view.parts = currentPartsMask();
  return view;
}

const currentViewToken = () => formatViewToken(captureView(), partsDefaultMask);
const currentViewFragment = () => formatViewFragment(captureView(), partsDefaultMask);

let animation = null;

/**
 * The trackball keeps a fling going after the pointer lifts. After the camera is
 * put somewhere on purpose that residue would carry on nudging it, so clear it.
 * These are private fields of the vendored r169 copy (pinned in package.json);
 * check them when upgrading three.
 */
function stopFling() {
  controls._lastAngle = 0;
  controls._movePrev.copy(controls._moveCurr);
  controls._zoomStart.copy(controls._zoomEnd);
  controls._panStart.copy(controls._panEnd);
}

function setCamera(pose) {
  controls.target.set(pose.target.x, pose.target.y, pose.target.z);
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  camera.up.set(pose.up.x, pose.up.y, pose.up.z).normalize();
  camera.lookAt(controls.target);
  stopFling();
  controls.update();
  requestRender();
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Glide to a pose: orientation by slerp, target by lerp, and distance on a log
 * scale so a large zoom change feels even rather than front-loaded.
 */
/**
 * The orientation a camera at `position` has when it looks at `target` with `up`.
 *
 * This is exactly what camera.lookAt() computes, and it has to be: a camera looks
 * down its local -Z, so Matrix4.lookAt takes (eye, target). A plain Object3D's
 * lookAt points its +Z at the target instead — using one here made every glide
 * head for the mirror-image view and then snap round when setCamera() put the
 * real camera in place at the end.
 */
function cameraQuaternion(position, target, up) {
  const m = new THREE.Matrix4().lookAt(position, target, up);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function animateTo(pose, ms = 350) {
  const t0 = controls.target.clone();
  const t1 = new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z);
  const p1 = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z);
  const up1 = new THREE.Vector3(pose.up.x, pose.up.y, pose.up.z).normalize();
  const q0 = camera.quaternion.clone();
  const q1 = cameraQuaternion(p1, t1, up1);
  const d0 = camera.position.distanceTo(t0);
  const d1 = p1.distanceTo(t1);

  controls.enabled = false;
  stopFling();
  animation = { pose, start: performance.now(), ms, t0, t1, q0, q1, d0, d1 };
}

function stepAnimation(now) {
  const a = animation;
  const t = Math.min(1, (now - a.start) / a.ms);
  if (t >= 1) {
    endAnimation();
    return;
  }
  const s = easeInOutCubic(t);
  camera.quaternion.copy(a.q0).slerp(a.q1, s);
  controls.target.lerpVectors(a.t0, a.t1, s);
  const d = a.d0 * (a.d1 / a.d0) ** s;
  camera.position.set(0, 0, 1).applyQuaternion(camera.quaternion).multiplyScalar(d).add(controls.target);
  camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
}

function endAnimation() {
  const { pose } = animation;
  animation = null;
  controls.enabled = true;
  setCamera(pose);
}

/** Move to a view reference, optionally gliding there, and restore its parts. */
function applyView(view, { animate }) {
  if (!frame) return;
  const pose = viewToCamera(view, { center: frame.center, homeDistance: frame.distance });
  if (animate) animateTo(pose);
  else {
    if (animation) {
      animation = null;
      controls.enabled = true;
    }
    setCamera(pose);
  }
  if (view.parts) applyPartsMask(view.parts);
}

// Grabbing the model mid-glide hands it straight back, leaving the camera where
// the glide had got to. The controls ignore input while disabled, so this runs in
// the capture phase on the stage: re-enabled before their own listener sees the
// same press, which then starts the drag.
el('stage').addEventListener(
  'pointerdown',
  (event) => {
    if (animation && event.target === canvas) {
      animation = null;
      controls.enabled = true;
    }
  },
  { capture: true },
);

/**
 * Wheel and trackpad zoom, applied to the camera on the event itself.
 *
 * This is what made desktop zoom feel stuck. OrbitControls applied the dolly
 * inside its wheel handler and recorded the result, so the frame loop saw no
 * change and skipped drawing until something else moved; and TrackballControls'
 * own wheel zoom is damped and scaled for a notched mouse wheel, which a
 * trackpad's stream of tiny deltas — and a pinch, which macOS sends as a
 * ctrl+wheel — barely move. A capture listener on the stage runs before the
 * controls' listener on the canvas and handles both, exponentially, so the same
 * gesture zooms the same amount at any distance.
 */
el('stage').addEventListener(
  'wheel',
  (event) => {
    if (!frame || event.target !== canvas) return;
    event.preventDefault();
    event.stopPropagation();
    if (animation) {
      animation = null;
      controls.enabled = true;
    }
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= 100;
    const k = event.ctrlKey ? 0.01 : 0.002;
    const offset = camera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * Math.exp(delta * k),
      controls.minDistance,
      controls.maxDistance,
    );
    camera.position.copy(controls.target).add(offset.setLength(distance));
    stopFling();
    requestRender();
  },
  { capture: true, passive: false },
);

let readyPending = false;

function tick(now) {
  requestAnimationFrame(tick);
  if (animation) stepAnimation(now ?? performance.now());
  else controls.update();

  const moved =
    !lastDrawn.position.equals(camera.position) || !lastDrawn.quaternion.equals(camera.quaternion);
  if (needsRender || moved) {
    renderer.render(scene, camera);
    viewCube?.render();
    lastDrawn.position.copy(camera.position);
    lastDrawn.quaternion.copy(camera.quaternion);
    needsRender = false;
    if (readyPending) {
      readyPending = false;
      document.documentElement.dataset.viewerView = currentViewFragment();
      setViewerState('ready');
    }
  }
}

// --- navigation cube ---------------------------------------------------------

/**
 * The small cube in the corner: it turns with the model to show which side is
 * being looked at, and clicking it looks from there.
 *
 * Labels and the X/Y/Z triad are in MODEL axes, Z up — the frame the part was
 * designed in, and the way FreeCAD's own navigation cube reads — not three.js's
 * Y-up scene (see toModel in viewref.js). Each face is drawn as a faint 3×3 grid,
 * and a click picks one of 26 directions from where it lands: the middle square
 * looks straight at that side, a square along an edge looks along the edge's
 * diagonal, and a corner square looks from the corner — an isometric view. On
 * hover the whole region lights up across every face that shares it, so a corner
 * shows as one target on its three faces.
 *
 * It has its own canvas and renderer rather than a scissored corner of the main
 * one, so a click on it never also starts a trackball drag, and bare mode can drop
 * it without touching the main render.
 */
function createViewCube() {
  const cubeCanvas = el('viewCube');
  show(cubeCanvas);
  const cubeRenderer = new THREE.WebGLRenderer({ canvas: cubeCanvas, alpha: true, antialias: true });
  cubeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  cubeRenderer.setClearColor(0x000000, 0);
  cubeRenderer.autoClear = false;

  const cubeScene = new THREE.Scene();
  const overlay = new THREE.Scene(); // the triad, drawn over the cube
  const cubeCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  const CAMERA_DISTANCE = 3.6;

  // Viewer-frame normal, and which way the label's top points. Top and Bottom
  // follow the FreeCAD convention the view references use: model +Y up the
  // screen looking down on Top, -Y looking up at Bottom.
  const FACES = [
    { label: 'Front', n: [0, 0, 1], up: [0, 1, 0] },
    { label: 'Back', n: [0, 0, -1], up: [0, 1, 0] },
    { label: 'Right', n: [1, 0, 0], up: [0, 1, 0] },
    { label: 'Left', n: [-1, 0, 0], up: [0, 1, 0] },
    { label: 'Top', n: [0, 1, 0], up: [0, 0, -1] },
    { label: 'Bottom', n: [0, -1, 0], up: [0, 0, 1] },
  ];

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /**
   * How much of each face, from each side, belongs to an edge or corner: the
   * grid lines, the hit test and the hover highlight all use this one number, so
   * what lights up is exactly what a click picks.
   */
  const BAND = 0.22;

  /** -1, 0 or 1 per axis for a point on the cube (scene frame, side 1). */
  const snap = (c) => (Math.abs(c) > 0.5 - BAND ? Math.sign(c) : 0);
  const regionKey = (p) => `${snap(p.x)},${snap(p.y)},${snap(p.z)}`;

  function faceTexture(label) {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = css('--surface');
    g.fillRect(0, 0, size, size);

    // The 3×3 grid: faint, so it reads as texture rather than as four more edges.
    const b = Math.round(size * BAND);
    g.strokeStyle = css('--border');
    g.lineWidth = 3;
    g.beginPath();
    for (const at of [b, size - b]) {
      g.moveTo(at, 0);
      g.lineTo(at, size);
      g.moveTo(0, at);
      g.lineTo(size, at);
    }
    g.stroke();
    g.lineWidth = 8;
    g.strokeRect(4, 4, size - 8, size - 8);

    // The label fits the middle square.
    const room = (size - 2 * b) * 0.9;
    let px = 52;
    const font = (n) => `600 ${n}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    g.font = font(px);
    while (px > 20 && g.measureText(label).width > room) g.font = font((px -= 2));
    g.fillStyle = css('--text');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, size / 2, size / 2 + 2);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  }

  const faces = FACES.map((face) => {
    const material = new THREE.MeshBasicMaterial({ map: faceTexture(face.label) });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    const n = new THREE.Vector3(...face.n);
    // Matrix4.lookAt(eye, target, up) points +Z from target to eye, which is a
    // plane's front side.
    const m = new THREE.Matrix4().lookAt(n, new THREE.Vector3(), new THREE.Vector3(...face.up));
    mesh.quaternion.setFromRotationMatrix(m);
    mesh.position.copy(n).multiplyScalar(0.5);
    mesh.userData.face = face;
    cubeScene.add(mesh);
    return mesh;
  });

  // Hover highlights: a 3×3 grid of squares just above each face, tagged with
  // the region it belongs to. They are not hit-tested; the faces are.
  cubeScene.updateMatrixWorld(true);
  const highlight = new THREE.MeshBasicMaterial({
    color: css('--accent') || '#2b5cd9',
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const cells = [
    { at: -0.5 + BAND / 2, size: BAND },
    { at: 0, size: 1 - 2 * BAND },
    { at: 0.5 - BAND / 2, size: BAND },
  ];
  const squares = [];
  for (const face of faces) {
    for (const u of cells) {
      for (const v of cells) {
        const square = new THREE.Mesh(new THREE.PlaneGeometry(u.size, v.size), highlight);
        square.position.set(u.at, v.at, 0.002);
        square.visible = false;
        face.add(square);
        square.updateMatrixWorld(true);
        square.userData.region = regionKey(square.getWorldPosition(new THREE.Vector3()));
        squares.push(square);
      }
    }
  }

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: css('--muted') || '#888' }),
  );
  cubeScene.add(edges);

  // The triad runs along the cube's edges from its model (-X, -Y, -Z) corner,
  // which is the scene's (-0.5, -0.5, +0.5).
  const origin = new THREE.Vector3(-0.5, -0.5, 0.5);
  const AXES = [
    { label: 'X', color: 0xd94a4a, dir: [1, 0, 0] },
    { label: 'Y', color: 0x3fa34d, dir: [0, 0, -1] },
    { label: 'Z', color: 0x4a6fd9, dir: [0, 1, 0] },
  ];
  const ARROW = 1.05;
  for (const axis of AXES) {
    const dir = new THREE.Vector3(...axis.dir);
    const arrow = new THREE.ArrowHelper(dir, origin, ARROW, axis.color, 0.14, 0.08);
    arrow.traverse((o) => {
      if (o.material) {
        o.material.depthTest = false;
        o.material.transparent = true;
      }
    });
    overlay.add(arrow);

    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = `#${axis.color.toString(16).padStart(6, '0')}`;
    g.font = '700 44px -apple-system, BlinkMacSystemFont, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(axis.label, 32, 34);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.setScalar(0.3);
    sprite.position.copy(origin).addScaledVector(dir, ARROW + 0.15);
    overlay.add(sprite);
  }

  function paint(mesh) {
    const old = mesh.material.map;
    mesh.material.map = faceTexture(mesh.userData.face.label);
    old?.dispose();
  }

  let hovered = null;
  function setHover(region) {
    if (region === hovered) return;
    hovered = region;
    for (const square of squares) square.visible = square.userData.region === region;
    cubeCanvas.style.cursor = region ? 'pointer' : '';
    requestRender();
  }

  const raycaster = new THREE.Raycaster();
  function hit(event) {
    const rect = cubeCanvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, cubeCamera);
    return raycaster.intersectObjects(faces, false)[0] ?? null;
  }

  /**
   * The direction a click asks for: each coordinate of the hit point within BAND
   * of its extreme counts, so one active axis is a face, two an edge and three a
   * corner.
   */
  function directionFor(point) {
    const m = toModel({ x: snap(point.x), y: snap(point.y), z: snap(point.z) });
    const len = Math.hypot(m.x, m.y, m.z);
    return { x: m.x / len, y: m.y / len, z: m.z / len };
  }

  let press = null;
  cubeCanvas.addEventListener('pointerdown', (event) => {
    press = { x: event.clientX, y: event.clientY, t: performance.now() };
    // A finger has no hover, so show what it is about to pick while it is down.
    if (event.pointerType === 'touch') {
      const h = hit(event);
      setHover(h ? regionKey(h.point) : null);
    }
  });
  cubeCanvas.addEventListener('pointerup', (event) => {
    const p = press;
    press = null;
    if (event.pointerType === 'touch') setHover(null);
    if (!p || !frame) return;
    if (Math.hypot(event.clientX - p.x, event.clientY - p.y) > 4 || performance.now() - p.t > 600) return;
    const h = hit(event);
    if (!h) return;
    const { az, el } = directionToAzEl(directionFor(h.point));
    // Keep zoom, pan and parts: the cube changes where you look from, nothing else.
    applyView({ ...captureView(), az, el, roll: 0 }, { animate: true });
  });
  cubeCanvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    const h = hit(event);
    setHover(h ? regionKey(h.point) : null);
  });
  cubeCanvas.addEventListener('pointerleave', () => setHover(null));

  return {
    render() {
      cubeCamera.quaternion.copy(camera.quaternion);
      cubeCamera.position.set(0, 0, CAMERA_DISTANCE).applyQuaternion(camera.quaternion);
      cubeRenderer.clear();
      cubeRenderer.render(cubeScene, cubeCamera);
      cubeRenderer.render(overlay, cubeCamera);
    },
    resize() {
      const w = cubeCanvas.clientWidth;
      const h = cubeCanvas.clientHeight;
      if (w && h) cubeRenderer.setSize(w, h, false);
    },
    retheme() {
      for (const mesh of faces) paint(mesh);
      highlight.color.set(css('--accent') || '#2b5cd9');
      edges.material.color.set(css('--muted') || '#888');
    },
  };
}

// --- parts panel ------------------------------------------------------------

function containsMesh(node) {
  let found = false;
  node.traverse((o) => {
    if (o.isMesh) found = true;
  });
  return found;
}

/**
 * Choose the nodes the parts panel toggles.
 *
 * An assembly exported from FreeCAD usually arrives wrapped in one or more
 * single-child container nodes, so descend past those before treating children
 * as components; a single-part export falls back to its meshes so the panel is
 * never empty-but-present.
 */
function componentNodes(root) {
  let node = root;
  while (node.children.length === 1 && containsMesh(node.children[0])) {
    node = node.children[0];
  }
  const branches = node.children.filter(containsMesh);
  if (branches.length > 1) return branches;

  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });
  if (meshes.length > 1) return meshes;
  return branches.length ? branches : meshes;
}

/**
 * Recover the name the exporter actually wrote.
 *
 * GLTFLoader runs every node name through three.js's animation-binding sanitizer,
 * which turns spaces and dots into underscores — so a FreeCAD label like
 * "Base Plate" or "Pad001.Body" would reach the parts panel mangled. The raw glTF
 * JSON is still on the parser, and `associations` maps each object back to its
 * node index, so the original label can be read straight out of it.
 */
function nameResolver(gltf) {
  const json = gltf.parser?.json ?? {};
  const associations = gltf.parser?.associations;
  return (object) => {
    const assoc = associations?.get(object);
    if (assoc) {
      const fromNode = json.nodes?.[assoc.nodes]?.name;
      if (fromNode) return fromNode;
      const fromMesh = json.meshes?.[assoc.meshes]?.name;
      if (fromMesh) return fromMesh;
    }
    return object.name || '';
  };
}

/**
 * Reference geometry: the thing a part mounts to, not the part itself.
 *
 * Assemblies routinely carry a body for context — a shower panel, a cabinet door,
 * a hook back plate — and nothing in a glTF distinguishes it from printed
 * geometry. The exporter's convention is a `ref_` label prefix, so a reviewer sees
 * the printed parts first and can switch the context back on.
 */
const REFERENCE_PREFIX = /^ref[\s_-]+/i;

/** The panel's checkboxes in order, and which were ticked on load. */
let partsInputs = [];
let partsDefaultMask = null;

/** One digit per panel entry, 1 = visible; null when there is no panel. */
function currentPartsMask() {
  return partsInputs.length ? partsInputs.map((i) => (i.checked ? '1' : '0')).join('') : null;
}

/**
 * Apply a view's parts. The mask is positional, so one written against a panel of
 * a different length (another revision's) is ignored rather than guessed at.
 */
function applyPartsMask(mask) {
  if (!mask || mask.length !== partsInputs.length) return;
  partsInputs.forEach((input, i) => {
    const want = mask[i] === '1';
    if (input.checked !== want) {
      input.checked = want;
      input.dispatchEvent(new Event('change'));
    }
  });
}

function buildPartsPanel(gltf) {
  const root = gltf.scene;
  const displayName = nameResolver(gltf);
  const nodes = componentNodes(root);
  const list = el('partsList');
  list.innerHTML = '';

  // With a single component there is nothing to toggle; leave the panel hidden
  // and drop its button rather than showing a checkbox that does nothing.
  if (nodes.length < 2) {
    hide(el('partsToggle'));
    return;
  }

  nodes.forEach((node, i) => {
    const id = `part-${i}`;
    const li = document.createElement('li');

    const raw = displayName(node) || `Part ${i + 1}`;
    const isReference = REFERENCE_PREFIX.test(raw);
    // Framing already happened and Box3 ignores `visible`, so starting a reference
    // part hidden does not move the camera.
    if (isReference) node.visible = false;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = !isReference;
    input.addEventListener('change', () => {
      node.visible = input.checked;
      requestRender();
    });

    const label = document.createElement('label');
    label.setAttribute('for', id);
    // Labels come from the model, so set text rather than markup.
    const name = isReference ? `${raw.replace(REFERENCE_PREFIX, '')} (reference)` : raw;
    label.textContent = name;
    label.title = name; // the panel truncates long labels

    li.append(input, label);
    list.append(li);
    partsInputs.push(input);
  });
  partsDefaultMask = currentPartsMask();

  el('partsAll').addEventListener('click', () => {
    for (const input of list.querySelectorAll('input[type=checkbox]')) {
      if (!input.checked) {
        input.checked = true;
        input.dispatchEvent(new Event('change'));
      }
    }
  });

  const toggle = el('partsToggle');
  show(toggle);
  toggle.addEventListener('click', () => {
    const nowHidden = el('partsPanel').classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!nowHidden));
  });
}

// --- comments ---------------------------------------------------------------

const NAME_KEY = 'threed_commenter_name';

function renderComments(comments) {
  const list = el('comments');
  list.innerHTML = '';
  el('commentCount').textContent = comments.length ? `(${comments.length})` : '';
  if (!comments.length) {
    show(el('commentsEmpty'));
    return;
  }
  hide(el('commentsEmpty'));

  for (const comment of comments) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'chead';

    const who = document.createElement('strong');
    who.textContent = comment.name || 'Anonymous';
    const when = document.createElement('span');
    when.className = 'meta';
    when.textContent = fmtDate(comment.at);
    head.append(who, when);

    const body = document.createElement('p');
    // Comments are untrusted free text: everything goes in as text nodes, and CSS
    // preserves the line breaks (see .ctext white-space in viewer.css). A view
    // reference becomes a button whose label is generated from the parsed numbers,
    // never from the comment's own characters.
    body.className = 'ctext';
    for (const segment of splitViewTokens(comment.text || '')) {
      if ('text' in segment) {
        body.append(document.createTextNode(segment.text));
        continue;
      }
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'viewref';
      chip.textContent = describeView(segment.view);
      chip.title = `Look from here: ${segment.raw}`;
      chip.addEventListener('click', () => {
        applyView(segment.view, { animate: true });
        el('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      body.append(chip);
    }

    li.append(head, body);
    list.append(li);
  }
}

function wireCommentForm(config, slug, rev) {
  const form = el('commentForm');
  const nameInput = el('commentName');
  const textInput = el('commentText');
  const submit = el('commentSubmit');
  const status = el('commentStatus');

  nameInput.value = localStorage.getItem(NAME_KEY) || '';
  wireViewInsertion(textInput);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = textInput.value.trim();
    if (!text) return;

    submit.disabled = true;
    status.className = 'status info';
    status.textContent = 'Posting…';

    try {
      const res = await fetch(`${config.apiUrl}/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: slug,
          revision: rev,
          name: nameInput.value.trim(),
          text,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not post (${res.status})`);

      localStorage.setItem(NAME_KEY, nameInput.value.trim());
      textInput.value = '';
      status.className = 'status ok';
      status.textContent = 'Thanks!';
      // The response carries the whole thread, so the new comment appears
      // without waiting for the CDN copy to expire.
      renderComments(body.comments || []);
    } catch (err) {
      status.className = 'status err';
      status.textContent = err.message || String(err);
    } finally {
      submit.disabled = false;
    }
  });
}

/**
 * Put a token at the caret (or in place of `from`..caret), padded with a space on
 * whichever side would otherwise run it into a word.
 */
function insertTokenAtCaret(textarea, token, from = textarea.selectionStart) {
  const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, from);
  const after = textarea.value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = !after || !/^\s/.test(after) ? ' ' : '';
  textarea.focus();
  textarea.setRangeText(lead + token + trail, from, end, 'end');
}

/**
 * Two ways to drop the current view into a comment, as often as the author likes:
 * the "Insert current view" button, and typing "@" at the start of a word, which
 * offers the same thing inline (Enter to take it, Escape or keep typing to not).
 */
function wireViewInsertion(textarea) {
  const menu = el('atMenu');
  const option = el('atInsertView');
  let atPos = null;

  const canInsert = () => Boolean(frame);
  const close = () => {
    atPos = null;
    hide(menu);
    textarea.setAttribute('aria-expanded', 'false');
  };
  const insert = (from) => {
    if (!canInsert()) return;
    insertTokenAtCaret(textarea, currentViewToken(), from);
    close();
  };

  el('insertView').addEventListener('click', () => insert());

  textarea.addEventListener('input', (event) => {
    const caret = textarea.selectionStart;
    const prev = textarea.value[caret - 2];
    if (
      event.inputType === 'insertText' &&
      event.data === '@' &&
      (prev === undefined || /\s/.test(prev)) &&
      canInsert()
    ) {
      atPos = caret - 1;
      show(menu);
      textarea.setAttribute('aria-expanded', 'true');
    } else {
      close();
    }
  });

  textarea.addEventListener('keydown', (event) => {
    if (atPos === null) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      insert(atPos);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'Tab') {
      event.preventDefault();
      option.focus();
    }
  });

  option.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      textarea.focus();
    }
  });
  // mousedown, not click: it fires before the textarea's blur closes the menu.
  option.addEventListener('mousedown', (event) => event.preventDefault());
  option.addEventListener('click', () => {
    if (atPos !== null) {
      // The caret moved with focus; put it back after the "@" before replacing it.
      textarea.focus();
      textarea.setSelectionRange(atPos + 1, atPos + 1);
      insert(atPos);
    }
  });
  textarea.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== option) close();
    }, 0);
  });
  textarea.addEventListener('click', close);
}

// --- provenance -------------------------------------------------------------

/**
 * Show where this revision was built from.
 *
 * Everything rendered here arrives in the public manifest, so it is untrusted text
 * exactly like a comment: values go in with `textContent` on created elements, never
 * as markup. The one field that looks like it wants to be a link — `cloneUrl` — is
 * deliberately rendered as plain text. It is a clone URL, not a page a reviewer
 * would click, and keeping it out of an `href` means no manifest value can ever
 * become a navigable URL here.
 *
 * The API caps and sanitizes each field (normalizeSource in the Lambda); this only
 * has to lay them out.
 */
function renderSource(source) {
  const section = el('sourceInfo');
  if (!source) return;

  const recreate = el('revRecreate');
  if (source.recreate) {
    recreate.textContent = source.recreate;
  } else {
    hide(recreate);
  }

  // Ordered most to least useful to someone trying to get the source back.
  const rows = [];
  if (source.repo) rows.push(['Repository', source.repo]);
  if (source.path) rows.push(['Path', source.path]);
  if (source.commit) rows.push(['Commit', source.commit]);
  if (source.ref) rows.push(['Branch or tag', source.ref]);
  if (source.build) rows.push(['Rebuild with', source.build]);
  if (source.cloneUrl) rows.push(['Clone from', source.cloneUrl]);
  if (source.dirty) {
    // Said in words, not as a bare "true": it is the one field that tells a reviewer
    // the commit alone does not identify what they are looking at.
    rows.push([
      'Uncommitted changes',
      source.tree
        ? `Yes — built from tree ${source.tree}, not from the commit as published`
        : 'Yes — the working tree had changes that are not in the commit',
    ]);
  }

  const list = el('revSource');
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dd.className = 'mono';
    // Long commits and URLs truncate in the layout; the full value stays reachable.
    dd.title = value;
    list.append(dt, dd);
  }
  if (!rows.length) hide(list);

  if (source.recreate || rows.length) show(section);
}

/**
 * The model download. Its href is composed from the path rather than taken from the
 * manifest, so it cannot be influenced by published data; the file is already public
 * at this URL, so this only saves a reviewer from having to know that.
 */
function renderDownloads(slug, rev, bytes) {
  const link = document.createElement('a');
  link.href = `/${encodeURIComponent(slug)}/${rev}/model.glb`;
  link.setAttribute('download', `${slug}-rev${rev}.glb`);
  link.textContent = `Download model (.glb${bytes ? `, ${fmtBytes(bytes)}` : ''})`;
  el('revDownloads').append(link);
}

// --- revision navigation ----------------------------------------------------

function wireRevisionNav(slug, revisions, index) {
  const prev = el('prevRev');
  const next = el('nextRev');
  const select = el('revSelect');

  // Neighbours come from the manifest, not from rev±1: revision numbers are
  // never reused, so a deleted revision leaves a gap in the sequence.
  const before = revisions[index - 1];
  const after = revisions[index + 1];

  prev.disabled = !before;
  next.disabled = !after;
  if (before) prev.addEventListener('click', () => location.assign(`/${slug}/${before.rev}`));
  if (after) next.addEventListener('click', () => location.assign(`/${slug}/${after.rev}`));

  select.innerHTML = '';
  revisions.forEach((r, i) => {
    const option = document.createElement('option');
    option.value = String(r.rev);
    const when = r.publishedAt ? ` · ${fmtDate(r.publishedAt)}` : '';
    const count = r.commentCount ? ` · ${r.commentCount} comment${r.commentCount === 1 ? '' : 's'}` : '';
    option.textContent = `Rev ${r.rev}${when}${count}`;
    option.selected = i === index;
    select.append(option);
  });
  select.addEventListener('change', () => {
    if (Number(select.value) !== revisions[index].rev) {
      location.assign(`/${slug}/${select.value}`);
    }
  });

  show(el('revnav'));
}

// --- boot -------------------------------------------------------------------

/**
 * `?bare=1` is the canvas alone, for screenshots: no title bar, revision pill,
 * parts panel, navigation cube or feedback below. render_view loads it.
 */
const bare = new URLSearchParams(location.search).get('bare') === '1';

/** The share URL's `#view(...)`, if it carries one that parses. */
function viewFromHash() {
  if (!location.hash) return null;
  try {
    return parseView(decodeURIComponent(location.hash.slice(1)));
  } catch {
    return null;
  }
}

function wireCopyView(slug, rev) {
  const button = el('copyView');
  let timer = null;
  const flash = (label) => {
    button.textContent = label;
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.textContent = 'Copy view';
    }, 1500);
  };
  button.addEventListener('click', async () => {
    if (!frame) return;
    const url = `${location.origin}/${encodeURIComponent(slug)}/${rev}#${currentViewFragment()}`;
    try {
      await navigator.clipboard.writeText(url);
      flash('Copied');
    } catch {
      // No clipboard (an insecure context, or permission refused): put the link
      // where it can be copied by hand.
      history.replaceState(null, '', url);
      flash('In address bar');
    }
  });
}

async function main() {
  setViewerState('loading');
  if (bare) document.body.classList.add('bare');
  else viewCube = createViewCube();
  resize();
  tick();

  const { slug, rev: requestedRev } = parsePath(location.pathname);
  if (!slug) {
    fail('Nothing to show', 'This URL has no project in it. Ask for a share link.');
    return;
  }

  const configRes = await getJson('/viewer/config.json');
  const config = configRes.body || {};

  const manifestRes = await getJson(`/projects/${encodeURIComponent(slug)}.json`);
  if (!manifestRes.ok || !manifestRes.body) {
    fail('Project not found', `There is no project called “${slug}” here.`);
    return;
  }
  const manifest = manifestRes.body;
  const revisions = Array.isArray(manifest.revisions) ? manifest.revisions : [];
  if (!revisions.length) {
    fail('Nothing published yet', `“${slug}” has no published revisions.`);
    return;
  }

  // No revision in the URL means "latest": rewrite the address so the link the
  // viewer copies from here points at a specific revision.
  let rev = requestedRev;
  if (rev === null) {
    rev = manifest.latest ?? revisions[revisions.length - 1].rev;
    // Keep the query and the fragment: a #view(...) on a "latest" link is the
    // whole point of the link.
    history.replaceState(null, '', `/${slug}/${rev}${location.search}${location.hash}`);
  }

  const index = revisions.findIndex((r) => r.rev === rev);
  if (index === -1) {
    const available = revisions.map((r) => r.rev).join(', ');
    fail('Revision not found', `Revision ${rev} of “${slug}” does not exist. Available: ${available}.`);
    return;
  }
  const current = revisions[index];

  // --- chrome ---
  const title = manifest.title || slug;
  document.title = `${title} · rev ${rev}`;
  el('projectTitle').textContent = title;
  el('revLine').textContent = `Revision ${rev} · ${index + 1} of ${revisions.length}`;
  el('revNotes').textContent = current.notes || 'No notes for this revision.';
  el('revMeta').textContent = [
    current.publishedAt ? `Published ${fmtDate(current.publishedAt)}` : '',
    fmtBytes(current.bytes),
  ]
    .filter(Boolean)
    .join(' · ');
  renderDownloads(slug, rev, current.bytes);
  renderSource(current.source);
  show(el('topbar'));
  show(el('below'));
  wireRevisionNav(slug, revisions, index);
  el('resetView').addEventListener('click', resetView);
  wireCopyView(slug, rev);

  // --- comments (independent of the model load) ---
  wireCommentForm(config, slug, rev);
  getJson(`/comments/${encodeURIComponent(slug)}/${rev}.json`).then((res) => {
    renderComments(res.body?.comments || []);
  });

  // --- model ---
  const loader = new GLTFLoader();
  loader.load(
    `/${encodeURIComponent(slug)}/${rev}/model.glb`,
    (gltf) => {
      scene.add(gltf.scene);
      frameObject(gltf.scene);
      buildPartsPanel(gltf);
      // After the parts panel exists, so a view's parts mask has something to set.
      const linked = viewFromHash();
      if (linked) applyView(linked, { animate: false });
      readyPending = true;
      requestRender();
      hide(el('loading'));
    },
    (progress) => {
      if (progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        el('loadingText').textContent = `Loading model… ${pct}%`;
      }
    },
    (err) => {
      console.error(err);
      fail(
        'Could not load the model',
        'The model file for this revision could not be read. It may still be processing — try reloading in a moment.',
      );
    },
  );
}

main().catch((err) => {
  console.error(err);
  fail('Something went wrong', err?.message || String(err));
});
