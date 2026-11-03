/**
 * View references for the MCP server: the TypeScript mirror of
 * viewer-app/viewref.js.
 *
 * The viewer is build-free ES modules and this server is CommonJS under ts-node,
 * so the two cannot share one file cleanly; test/viewref.test.ts runs the same
 * table through both, the way test/mcp-glb.test.ts pins the parts-panel pair.
 * See the browser module for the meaning of each field.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface View {
  az: number;
  el: number;
  zoom: number;
  roll: number;
  pan: Vec3;
  parts: string | null;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

export interface Frame {
  center: Vec3;
  homeDistance: number;
}

export type ViewSegment = { text: string } | { view: View; raw: string };


const DEG = 180 / Math.PI;
/** Within this many degrees of a pole the "natural up" switches to ±Y. */
const POLE_DEG = 89.5;

// --- vectors ------------------------------------------------------------------

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a: Vec3, s: number): Vec3 => vec(a.x * s, a.y * s, a.z * s);
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const length = (a: Vec3): number => Math.sqrt(dot(a, a));
const normalize = (a: Vec3): Vec3 => {
  const n = length(a);
  return n > 0 ? scale(a, 1 / n) : vec(0, 0, 0);
};
/** The part of `a` perpendicular to the unit vector `v`. */
const perp = (a: Vec3, v: Vec3): Vec3 => sub(a, scale(v, dot(a, v)));
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * Models are exported Z-up → Y-up as (x, y, z) → (x, z, -y), so the scene's +Y
 * is the model's +Z and the scene's -Z is the model's +Y.
 */
export function toModel(p: Vec3): Vec3 {
  return vec(p.x, -p.z, p.y);
}
export function toViewer(m: Vec3): Vec3 {
  return vec(m.x, m.z, -m.y);
}

// --- orientation --------------------------------------------------------------

/**
 * Which way is "up the screen" for a camera looking along -v, before any roll.
 * Away from the poles it is the model's Z axis projected onto the view plane.
 * Looking straight down Z there is nothing to project, so FreeCAD's convention
 * is used: Top puts +Y at the top of the screen, Bottom puts -Y there (Bottom is
 * Top turned over about X, so +X stays on the right). Both agree with the
 * generic rule when approached from the Front, so a token stays continuous
 * along the most common path to a pole.
 */
function naturalUp(v: Vec3, el: number): Vec3 {
  if (el >= POLE_DEG) return normalize(perp(vec(0, 1, 0), v));
  if (el <= -POLE_DEG) return normalize(perp(vec(0, -1, 0), v));
  return normalize(perp(vec(0, 0, 1), v));
}

/** Azimuth and elevation (degrees, model frame) of a unit direction. */
export function directionToAzEl(v: Vec3): { az: number; el: number } {
  const el = Math.asin(clamp(v.z, -1, 1)) * DEG;
  const az = Math.atan2(v.x, -v.y) * DEG;
  return { az, el };
}

function azElToDirection(az: number, el: number): Vec3 {
  const a = az / DEG;
  const e = el / DEG;
  return vec(Math.cos(e) * Math.sin(a), -Math.cos(e) * Math.cos(a), Math.sin(e));
}

/**
 * Read the view off a camera. Every input is in the scene's (viewer) frame:
 * `position`, `target` and `up` from the camera and controls, `center` the
 * model's bounding-sphere centre and `homeDistance` the framing distance.
 */
export function cameraToView({ position, target, up, center, homeDistance }: CameraPose & Frame): View {
  const offset = sub(position, target);
  const distance = length(offset);
  const v = normalize(toModel(offset));
  const { az, el } = directionToAzEl(v);
  const u0 = naturalUp(v, el);
  const upm = normalize(perp(toModel(up), v));
  const roll = Math.atan2(dot(cross(u0, upm), v), dot(u0, upm)) * DEG;
  return {
    az,
    el,
    zoom: distance > 0 ? homeDistance / distance : 1,
    roll: Number.isFinite(roll) ? roll : 0,
    pan: toModel(sub(target, center)),
    parts: null,
  };
}

/** The inverse: where to put the camera for a view. Outputs are viewer-frame. */
export function viewToCamera(
  view: Pick<View, 'az' | 'el' | 'zoom'> & Partial<View>,
  { center, homeDistance }: Frame,
): CameraPose {
  const v = azElToDirection(view.az, view.el);
  const d = homeDistance / (view.zoom || 1);
  const u0 = naturalUp(v, view.el);
  const r = (view.roll || 0) / DEG;
  const upm = add(scale(u0, Math.cos(r)), scale(cross(v, u0), Math.sin(r)));
  const pan = view.pan || vec(0, 0, 0);
  const target = add(center, toViewer(pan));
  return {
    target,
    position: add(target, scale(toViewer(v), d)),
    up: toViewer(upm),
  };
}

// --- token text ---------------------------------------------------------------

/** Matches a token inside free text. A fresh copy is used per scan (it is /g). */
export const VIEW_TOKEN_RE = /@view\(([A-Za-z0-9=,.\-]+)\)/g;

const NUMBER_RE = /^-?[0-9]+(\.[0-9]+)?$/;
const PARTS_RE = /^[01]{1,64}$/;
const KEYS = ['az', 'el', 'zoom', 'roll', 'pan', 'parts'];

/**
 * Parse `@view(...)`, `view(...)` or the bare `az=...` list. Returns null for
 * anything malformed — a comment that merely looks like a token is shown as the
 * text it is rather than moving the camera somewhere surprising.
 */
export function parseView(text: unknown): View | null {
  if (typeof text !== 'string') return null;
  let inner = text.trim();
  const wrapped = /^@?view\(([^()]*)\)$/.exec(inner);
  if (wrapped) inner = wrapped[1];
  else if (/[()@]/.test(inner)) return null;
  if (!inner) return null;

  const values: Record<string, string[]> = {};
  let current: string | null = null;
  for (const item of inner.split(',')) {
    const eq = item.indexOf('=');
    if (eq !== -1) {
      const key = item.slice(0, eq);
      if (!KEYS.includes(key) || key in values) return null;
      current = key;
      values[key] = [item.slice(eq + 1)];
    } else if (current) {
      values[current].push(item);
    } else {
      return null;
    }
  }

  for (const key of ['az', 'el', 'zoom']) if (!(key in values)) return null;
  for (const key of ['az', 'el', 'zoom', 'roll']) {
    if (key in values && (values[key].length !== 1 || !NUMBER_RE.test(values[key][0]))) return null;
  }
  if ('pan' in values && (values.pan.length !== 3 || !values.pan.every((s) => NUMBER_RE.test(s)))) return null;
  if ('parts' in values && (values.parts.length !== 1 || !PARTS_RE.test(values.parts[0]))) return null;

  const az = Number(values.az[0]);
  const el = Number(values.el[0]);
  const zoom = Number(values.zoom[0]);
  const roll = 'roll' in values ? Number(values.roll[0]) : 0;
  if (az < -180 || az > 180 || el < -90 || el > 90 || roll < -180 || roll > 180) return null;
  if (!(zoom > 0.001 && zoom < 1000)) return null;

  return {
    az,
    el,
    zoom,
    roll,
    pan: 'pan' in values ? vec(Number(values.pan[0]), Number(values.pan[1]), Number(values.pan[2])) : vec(0, 0, 0),
    parts: 'parts' in values ? values.parts[0] : null,
  };
}

/** Round to a tenth (angles) or a hundredth, with -0 and -180 normalised. */
function fmt(x: number, decimals: number): string {
  const f = 10 ** decimals;
  let r = Math.round(x * f) / f;
  if (r === 0) r = 0; // drops the sign of -0
  if (decimals === 1 && r === -180) r = 180;
  return String(r);
}

/**
 * Looking straight down or up, azimuth says nothing (roll carries the
 * orientation there), so print 0 rather than whatever the float noise of a pole
 * produced — a top view should read `az=0,el=90`, not `az=137,el=90`.
 */
function shownAz(view: Pick<View, 'az' | 'el'>): number {
  return Math.abs(Number(fmt(view.el, 1))) === 90 ? 0 : view.az;
}

/** `view(az=…,el=…,zoom=…[,roll=…][,pan=x,y,z][,parts=…])` — the URL fragment. */
export function formatViewFragment(view: Partial<View> & Pick<View, 'az' | 'el' | 'zoom'>, defaultParts?: string | null): string {
  const fields = [`az=${fmt(shownAz(view), 1)}`, `el=${fmt(view.el, 1)}`, `zoom=${fmt(view.zoom, 2)}`];
  const roll = fmt(view.roll || 0, 1);
  if (roll !== '0') fields.push(`roll=${roll}`);
  if (view.pan) {
    const pan = [view.pan.x, view.pan.y, view.pan.z].map((n) => fmt(n, 2));
    if (pan.some((s) => s !== '0')) fields.push(`pan=${pan.join(',')}`);
  }
  if (view.parts && view.parts !== defaultParts) fields.push(`parts=${view.parts}`);
  return `view(${fields.join(',')})`;
}

/** The same, prefixed for a comment. */
export function formatViewToken(view: Partial<View> & Pick<View, 'az' | 'el' | 'zoom'>, defaultParts?: string | null): string {
  return `@${formatViewFragment(view, defaultParts)}`;
}

/**
 * Split comment text into plain runs and view references. A token that does not
 * parse stays in the text run around it.
 */
export function splitViewTokens(text: string): ViewSegment[] {
  const out: ViewSegment[] = [];
  const re = new RegExp(VIEW_TOKEN_RE.source, 'g');
  let last = 0;
  let pending = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const view = parseView(m[0]);
    if (!view) continue; // left inside the surrounding text
    pending += text.slice(last, m.index);
    if (pending) out.push({ text: pending });
    pending = '';
    out.push({ view, raw: m[0] });
    last = m.index + m[0].length;
  }
  pending += text.slice(last);
  if (pending) out.push({ text: pending });
  return out;
}

/** A short human label for a chip: `👁 az −35° · el 22° · 1.6×`. */
export function describeView(view: Partial<View> & Pick<View, 'az' | 'el' | 'zoom'>): string {
  const neg = (s: string): string => s.replace('-', '−');
  const parts = [`az ${neg(fmt(shownAz(view), 1))}°`, `el ${neg(fmt(view.el, 1))}°`, `${fmt(view.zoom, 2)}×`];
  const roll = fmt(view.roll || 0, 1);
  if (roll !== '0') parts.push(`roll ${neg(roll)}°`);
  if (view.pan && [view.pan.x, view.pan.y, view.pan.z].some((n) => fmt(n, 2) !== '0')) parts.push('pan');
  if (view.parts) parts.push('parts');
  return `\u{1F441} ${parts.join(' · ')}`;
}
