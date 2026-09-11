/* Shared admin SPA logic: config load, Cognito Hosted-UI PKCE auth, API calls.
 * Vanilla ES module, no build step. Loaded by the login and admin pages.
 *
 * Adapted from the mocks-host admin app; the share URL is project + revision
 * instead of a single UID.
 *
 * The session handling has since diverged from that original, and the reason is
 * worth stating once here because it shapes several functions below: a signed-in
 * session is meant to last as long as the refresh token does (90 days, set on the
 * user pool client), so **nothing transient may be allowed to end one**. A
 * throttled or unreachable token endpoint is retried and the tokens are kept; only
 * Cognito rejecting the grant outright discards them. Everything else here —
 * refreshing early, sharing one in-flight refresh, redirecting straight to Google,
 * pinning the app to one origin — exists to keep a re-authentication from being
 * something the user has to notice, let alone do. */

// --- config -----------------------------------------------------------------

/**
 * Where a signed-in session lands when it has nowhere more specific to go.
 *
 * /browse rather than /admin, because it is the page both roles can use: a
 * read-only account has no business on /admin, and an admin gets a link to it from
 * here. Deep links are unaffected — they return to the page that sent them.
 */
export const HOME = '/browse';

let _config = null;
export async function getConfig() {
  if (_config) return _config;
  const res = await fetch('/app/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load config.json');
  _config = await res.json();
  return _config;
}

/**
 * Serve the admin app from one origin.
 *
 * The CloudFront domain and the custom domain are both registered callback URLs,
 * so both work — but localStorage is per-origin, and tokens saved on one are
 * invisible on the other. Landing on the wrong one therefore looks exactly like
 * being signed out. Redirect to the canonical host so there is only ever one
 * token store.
 */
export async function canonicalizeOrigin() {
  const cfg = await getConfig();
  const canonical = cfg.shareDomain;
  if (!canonical || canonical === window.location.hostname) return false;
  // Only the CloudFront alias is redirected. Anything else (localhost, a
  // preview host) is left alone rather than bounced somewhere unexpected.
  if (window.location.hostname !== cfg.cloudFrontDomain) return false;
  window.location.replace(
    `https://${canonical}${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  return true;
}

// --- retry timing ------------------------------------------------------------

/** Exponential backoff with jitter, capped — shared by the API and the refresh. */
function backoff(attempt) {
  return Math.min(4000, 300 * 2 ** attempt) + Math.random() * 200;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * The in-flight leg of a sign-in: PKCE verifier, CSRF state, and where to go
 * afterwards.
 *
 * This lives in localStorage rather than sessionStorage on purpose. sessionStorage
 * is per-tab, and the Hosted UI does not promise to return to the tab it left —
 * when it does not, the verifier is simply gone and the callback dead-ends on
 * "State mismatch". It is short-lived (PENDING_TTL_MS) and deleted the moment it
 * is used, so widening its scope costs nothing that matters.
 */
const PENDING_KEY = 'threed_pending_login';
const PENDING_TTL_MS = 10 * 60 * 1000;

function savePending(pending) {
  localStorage.setItem(PENDING_KEY, JSON.stringify({ ...pending, at: Date.now() }));
}
/** Read and consume the pending login; null when absent or too old. */
function takePending() {
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); }
  catch { pending = null; }
  localStorage.removeItem(PENDING_KEY);
  if (!pending || Date.now() - (pending.at ?? 0) > PENDING_TTL_MS) return null;
  return pending;
}

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

/**
 * Raised when the refresh token is genuinely dead and only a fresh sign-in will
 * do. Every *other* failure — offline, throttled, a Cognito 5xx — is transient
 * and must not be allowed to look like this one, because the response to this is
 * to throw the session away.
 */
class AuthExpired extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthExpired';
  }
}

export async function beginLogin({ returnTo } = {}) {
  const cfg = await getConfig();
  const verifier = randomString(96);
  const challenge = base64UrlEncode(await sha256(verifier));
  const state = randomString(24);
  // Come back to the page that sent us — but never to /login itself, which would
  // only bounce again once it saw the new token. Signing in *at* /login lands on
  // /browse, the one page both roles can use: an admin arriving from /admin still
  // returns to /admin, because that is `here`.
  const here = `${window.location.pathname}${window.location.hash}`;
  savePending({
    verifier,
    state,
    returnTo: returnTo ?? (window.location.pathname === '/login' ? HOME : here),
  });

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

async function exchangeCodeForTokens(code, verifier) {
  const cfg = await getConfig();
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

/**
 * Trade the refresh token for a fresh ID token, distinguishing "you need to sign
 * in again" from "that did not work just now".
 *
 * The distinction is the whole point. Cognito's token endpoint is throttled and
 * has bad minutes, and the browser goes offline; treating any of that as an
 * expired session means one blip discards a session that had months left on it.
 * Only an `invalid_grant` (or a client the pool no longer recognises) is fatal.
 */
async function refreshTokens(refreshToken, { retries = 4 } = {}) {
  const cfg = await getConfig();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.userPoolClientId,
    refresh_token: refreshToken,
  });

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(`${hostedUiBase(cfg)}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      // A thrown fetch is the network, not the grant.
      if (attempt < retries) {
        await sleep(backoff(attempt++));
        continue;
      }
      throw new Error('Could not reach sign-in. Check your connection and try again.');
    }

    if (res.ok) return res.json();

    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries) {
        await sleep(backoff(attempt++));
        continue;
      }
      throw new Error(`Sign-in is temporarily unavailable (${res.status}). Try again shortly.`);
    }

    // A 4xx that is not a throttle: read the OAuth error to decide whether the
    // grant itself is dead. An unparseable body from a 400 is treated as dead
    // too — that is what Cognito sends for a rejected grant.
    let oauthError = '';
    try { oauthError = (await res.clone().json())?.error ?? ''; } catch { oauthError = ''; }
    if (
      oauthError === 'invalid_grant' ||
      oauthError === 'unauthorized_client' ||
      oauthError === 'invalid_client' ||
      res.status === 400 ||
      res.status === 401
    ) {
      throw new AuthExpired('Your session has expired.');
    }
    throw new Error(`Sign-in failed (${res.status}).`);
  }
}

/**
 * Handle the Hosted-UI redirect back to /login if a ?code= is present.
 * Returns `{ returnTo }` if this was a callback (and tokens were stored),
 * or null if it was not.
 */
export async function handleAuthCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) throw new Error(url.searchParams.get('error_description') || error);
  if (!code) return null;
  // Consumed here whether or not it matches: a verifier is good for one exchange,
  // and leaving a stale one behind only invites a confusing second failure.
  const pending = takePending();
  if (!pending || state !== pending.state) {
    throw new Error('That sign-in link has already been used or expired. Try signing in again.');
  }
  const tokens = await exchangeCodeForTokens(code, pending.verifier);
  saveTokens(tokens);
  clearReauthAttempt();
  // Scrub the code/state from the URL bar.
  window.history.replaceState({}, document.title, '/login');
  return { returnTo: pending.returnTo || HOME };
}

/**
 * Refresh this far ahead of expiry. Generous on purpose: the point is that the
 * token is never actually expired at the moment something needs it, so a slow
 * refresh degrades into a slow request rather than into a sign-in.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** In-flight refresh, shared so parallel callers make one request, not several. */
let _refreshing = null;

/**
 * A valid ID token, refreshing if needed.
 *
 * Returns null only when there is genuinely no session to work with. A refresh
 * that failed for a transient reason **throws** instead, so a caller reports it
 * rather than silently concluding the user is signed out and bouncing them to a
 * login screen.
 */
export async function getIdToken() {
  const tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() <= tokens.expiresAt - REFRESH_MARGIN_MS) return tokens.id_token || null;
  if (!tokens.refresh_token) {
    clearTokens();
    return null;
  }

  _refreshing ??= refreshTokens(tokens.refresh_token)
    .then((refreshed) => {
      // Cognito omits refresh_token on refresh; keep the existing one.
      saveTokens({ ...refreshed, refresh_token: tokens.refresh_token });
      return loadTokens()?.id_token || null;
    })
    .catch((err) => {
      // Only a dead grant costs the session. Anything else leaves the tokens in
      // place so the next attempt — or the next page load — can succeed.
      if (err instanceof AuthExpired) {
        clearTokens();
        return null;
      }
      throw err;
    })
    .finally(() => { _refreshing = null; });

  return _refreshing;
}

export async function logout() {
  const cfg = await getConfig();
  clearTokens();
  // Signing out is deliberate, so leave nothing behind that a later page load
  // could mistake for a sign-in already in progress.
  localStorage.removeItem(PENDING_KEY);
  clearReauthAttempt();
  const params = new URLSearchParams({
    client_id: cfg.userPoolClientId,
    logout_uri: `${window.location.origin}/login`,
  });
  window.location.assign(`${hostedUiBase(cfg)}/logout?${params}`);
}

/**
 * Guard against a re-auth loop.
 *
 * Going straight to the IdP is only safe if a failure cannot bounce forever. One
 * stamp per attempt: a second one arriving within the window means the round trip
 * came back still unauthenticated, so stop and show the sign-in page instead.
 */
const REAUTH_KEY = 'threed_reauth_at';
const REAUTH_WINDOW_MS = 30 * 1000;

function clearReauthAttempt() { sessionStorage.removeItem(REAUTH_KEY); }

function recentlyAttemptedReauth() {
  const at = Number(sessionStorage.getItem(REAUTH_KEY) || 0);
  return at > 0 && Date.now() - at < REAUTH_WINDOW_MS;
}

/**
 * Ensure a valid token, re-authenticating if there is none. Returns the token,
 * or never returns — it throws after starting a redirect.
 *
 * When the session really is gone this goes **straight to Google** rather than to
 * a page with a button on it. Google's own session almost always outlives ours, so
 * what used to be a visible sign-in becomes an invisible redirect. The button on
 * /login still exists for the case where that does not work.
 */
export async function requireAuth() {
  const token = await getIdToken();
  if (token) {
    clearReauthAttempt();
    return token;
  }
  if (recentlyAttemptedReauth()) {
    // Just came back from the IdP and still have nothing. Stop, and let the user
    // sign in deliberately rather than ping-ponging.
    window.location.assign('/login?reauth=failed');
    throw new Error('redirecting to login');
  }
  sessionStorage.setItem(REAUTH_KEY, String(Date.now()));
  await beginLogin();
  throw new Error('redirecting to login');
}

// --- API calls ---------------------------------------------------------------

/** Call an admin API action with bearer auth and retry on throttle (429/5xx). */
export async function api(action, payload, { retries = 4 } = {}) {
  const cfg = await getConfig();
  // A transient refresh failure propagates rather than being read as "signed
  // out", so a bad minute at Cognito surfaces as an error the user can retry
  // instead of as a sign-in they did not ask for.
  const token = await getIdToken();
  if (!token) {
    await requireAuth(); // starts a redirect and throws; never falls through
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
        await sleep(backoff(attempt++));
        continue;
      }
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      // The status rides on the error so a caller can act on the *kind* of failure
      // — a 403 from an admin action means "wrong role", which /admin answers by
      // sending the caller to /browse — without matching on message text.
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

/**
 * Keep the token fresh while a tab sits open, so returning to a page left open
 * overnight is not the moment a refresh is discovered to be needed.
 *
 * A transient failure here is swallowed: nothing is waiting on it, and the next
 * real request will try again.
 */
export function startTokenRefresh(intervalMs = 50 * 60 * 1000) {
  return setInterval(() => { getIdToken().catch(() => {}); }, intervalMs);
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

/** Collapse a revision note to one line past this many characters. */
export const NOTE_PREVIEW_CHARS = 100;
/**
 * How far over the limit a note may run before it is worth collapsing. Without
 * this, a note a few characters too long gets a toggle that reveals almost
 * nothing — which costs more height than it saves.
 */
const NOTE_PREVIEW_SLACK = 20;
/** More lines than this is worth collapsing however short the note is. */
const NOTE_PREVIEW_LINES = 2;

/**
 * The collapsed form of a revision note, or null when collapsing it would gain
 * nothing.
 *
 * Notes are prose — up to MAX_NOTES_LEN, and `.note` renders them `pre-wrap` — so
 * a few verbose ones set the scroll height of the whole page. The preview is
 * deliberately a single line: flattening newlines is what makes this work for a
 * note that is *tall* as well as one that is merely long, and those are different
 * problems (twelve short lines take more room than one hundred characters).
 *
 * Returning null rather than the text itself is the point of the signature: the
 * caller offers a toggle only where one actually hides something.
 */
export function notePreview(text, {
  chars = NOTE_PREVIEW_CHARS,
  slack = NOTE_PREVIEW_SLACK,
  lines = NOTE_PREVIEW_LINES,
} = {}) {
  const full = String(text ?? '').trim();
  if (full.length <= chars + slack && full.split('\n').length <= lines) return null;

  const oneLine = full.replace(/\s+/g, ' ');
  // Short but tall: the whole note fits once its newlines are gone.
  if (oneLine.length <= chars) return oneLine;

  const cut = oneLine.slice(0, chars);
  const lastSpace = cut.lastIndexOf(' ');
  // Prefer a word boundary, but not at the cost of most of the preview — a note
  // with one very long token would otherwise collapse to almost nothing.
  const trimmed = lastSpace > chars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.trimEnd()}…`;
}
