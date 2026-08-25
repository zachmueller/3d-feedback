/* Shared admin SPA logic: config load, Cognito Hosted-UI PKCE auth, API calls.
 * Vanilla ES module, no build step. Loaded by the login and admin pages.
 *
 * Adapted from the mocks-host admin app; the auth flow is unchanged, the share
 * URL is project + revision instead of a single UID. */

// --- config -----------------------------------------------------------------

let _config = null;
export async function getConfig() {
  if (_config) return _config;
  const res = await fetch('/app/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load config.json');
  _config = await res.json();
  return _config;
}

// --- PKCE helpers ------------------------------------------------------------

function base64UrlEncode(bytes) {
  let str = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr).slice(0, len);
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  return crypto.subtle.digest('SHA-256', data);
}

// --- token storage -----------------------------------------------------------

const TOKENS_KEY = 'threed_tokens';

function saveTokens(tokens) {
  // Stamp an absolute expiry so we can refresh proactively.
  const expiresAt = Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : 3600 * 1000);
  localStorage.setItem(TOKENS_KEY, JSON.stringify({ ...tokens, expiresAt }));
}
function loadTokens() {
  try { return JSON.parse(localStorage.getItem(TOKENS_KEY) || 'null'); }
  catch { return null; }
}
function clearTokens() { localStorage.removeItem(TOKENS_KEY); }

function hostedUiBase(cfg) {
  return `https://${cfg.hostedUiDomain}`;
}

function redirectUri() {
  return `${window.location.origin}/login`;
}

// --- auth flow ---------------------------------------------------------------

export async function beginLogin() {
  const cfg = await getConfig();
  const verifier = randomString(96);
  const challenge = base64UrlEncode(await sha256(verifier));
  const state = randomString(24);
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('oauth_state', state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.userPoolClientId,
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    // Skip the Cognito provider chooser and go straight to Google.
    identity_provider: 'Google',
  });
  window.location.assign(`${hostedUiBase(cfg)}/oauth2/authorize?${params}`);
}

async function exchangeCodeForTokens(code) {
  const cfg = await getConfig();
  const verifier = sessionStorage.getItem('pkce_verifier');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.userPoolClientId,
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier || '',
  });
  const res = await fetch(`${hostedUiBase(cfg)}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  return res.json();
}

async function refreshTokens(refreshToken) {
  const cfg = await getConfig();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.userPoolClientId,
    refresh_token: refreshToken,
  });
  const res = await fetch(`${hostedUiBase(cfg)}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('refresh failed');
  return res.json();
}

/**
 * Handle the Hosted-UI redirect back to /login if a ?code= is present.
 * Returns true if this was a callback (and tokens were stored).
 */
export async function handleAuthCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) throw new Error(url.searchParams.get('error_description') || error);
  if (!code) return false;
  if (state !== sessionStorage.getItem('oauth_state')) {
    throw new Error('State mismatch; please try signing in again.');
  }
  const tokens = await exchangeCodeForTokens(code);
  saveTokens(tokens);
  // Scrub the code/state from the URL bar.
  window.history.replaceState({}, document.title, '/login');
  return true;
}

/** Returns a valid ID token, refreshing if needed, or null if not signed in. */
export async function getIdToken() {
  let tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() > tokens.expiresAt - 60000) {
    if (tokens.refresh_token) {
      try {
        const refreshed = await refreshTokens(tokens.refresh_token);
        // Cognito omits refresh_token on refresh; keep the existing one.
        saveTokens({ ...refreshed, refresh_token: tokens.refresh_token });
        tokens = loadTokens();
      } catch {
        clearTokens();
        return null;
      }
    } else {
      clearTokens();
      return null;
    }
  }
  return tokens.id_token || null;
}

export async function logout() {
  const cfg = await getConfig();
  clearTokens();
  const params = new URLSearchParams({
    client_id: cfg.userPoolClientId,
    logout_uri: `${window.location.origin}/login`,
  });
  window.location.assign(`${hostedUiBase(cfg)}/logout?${params}`);
}

/** Redirect to /login unless a valid token is present. Returns the token. */
export async function requireAuth() {
  const token = await getIdToken();
  if (!token) {
    window.location.assign('/login');
    throw new Error('redirecting to login');
  }
  return token;
}

// --- API calls ---------------------------------------------------------------

/** Call an admin API action with bearer auth and retry on throttle (429/5xx). */
export async function api(action, payload, { retries = 4 } = {}) {
  const cfg = await getConfig();
  const token = await getIdToken();
  if (!token) {
    window.location.assign('/login');
    throw new Error('not authenticated');
  }
  const base = cfg.apiUrl.replace(/\/$/, '');
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt < retries) {
        const delay = Math.min(4000, 300 * 2 ** attempt) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
        continue;
      }
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
}

/** Canonical share URL. Omit the revision to link the project's latest. */
export function shareUrl(cfg, slug, rev) {
  const domain = cfg.shareDomain || cfg.cloudFrontDomain;
  return rev === undefined || rev === null
    ? `https://${domain}/${slug}`
    : `https://${domain}/${slug}/${rev}`;
}

// --- small DOM helpers -------------------------------------------------------

export function el(id) { return document.getElementById(id); }

export function setStatus(node, kind, html) {
  node.className = `status show ${kind}`;
  node.innerHTML = html;
}
export function hide(node) { node.className = node.className.replace(/\bshow\b/, '').trim(); }

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
