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
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';

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

function fail(title, message) {
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
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// Screen-space panning keeps two-finger drag feeling like moving the object,
// not sliding along an invisible ground plane.
controls.screenSpacePanning = true;

let needsRender = true;
const requestRender = () => {
  needsRender = true;
};

function applyTheme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  scene.background = new THREE.Color(dark ? 0x14161a : 0xf2f3f5);
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

let homeCamera = null;

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

  camera.near = Math.max(radius / 1000, 1e-4);
  camera.far = distance + radius * 10;
  camera.updateProjectionMatrix();

  // A three-quarter view reads as 3D immediately, unlike a face-on axis view.
  const direction = new THREE.Vector3(1, 0.6, 1).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  controls.target.copy(center);
  controls.minDistance = radius * 0.05;
  controls.maxDistance = distance * 8;
  controls.update();

  homeCamera = { position: camera.position.clone(), target: controls.target.clone() };
  requestRender();
}

function resetView() {
  if (!homeCamera) return;
  camera.position.copy(homeCamera.position);
  controls.target.copy(homeCamera.target);
  controls.update();
  requestRender();
}

function tick() {
  requestAnimationFrame(tick);
  // update() returns true while damping is still settling the camera.
  if (controls.update() || needsRender) {
    renderer.render(scene, camera);
    needsRender = false;
  }
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
  });

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
    // Comments are untrusted free text: assign as text and let CSS preserve the
    // line breaks (see .ctext white-space in viewer.css).
    body.className = 'ctext';
    body.textContent = comment.text || '';

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

async function main() {
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
    history.replaceState(null, '', `/${slug}/${rev}`);
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
