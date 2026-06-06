// Sample portal demonstrating @openvisio/sdk-js against the OpenVisio proxy.
//
// Mirrors the proxy's contract: the proxy authenticates your application with a
// single API key and trusts it — authorization logic (who can kick, mute, record)
// is enforced by your portal before calling the proxy. This backend therefore
// holds the key, owns sessions, and enforces the admin/guest boundary itself
// (returning 403) before ever touching the proxy.
//
//   cp .env.example .env && edit it
//   npm install && npm start  ->  http://localhost:4000
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import express from 'express';
import { OpenvisioServer } from '@openvisio/sdk-js/server';

const here = dirname(fileURLToPath(import.meta.url));

// Tiny .env loader (no dependency).
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env — rely on the shell environment */
}

const { PROXY_URL, OPENVISIO_URL, OPENVISIO_API_KEY, PORT = 4000 } = process.env;
if (!PROXY_URL || !OPENVISIO_URL || !OPENVISIO_API_KEY) {
  console.error('Missing PROXY_URL / OPENVISIO_URL / OPENVISIO_API_KEY (see .env.example).');
  process.exit(1);
}

// Keycloak portal client — real Authorization Code + PKCE login (BFF pattern).
const PORTAL_BASE = (process.env.PORTAL_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const KC = {
  base: (process.env.KEYCLOAK_URL || '').replace(/^(?!https?:\/\/)/, 'https://').replace(/\/+$/, ''),
  realm: process.env.KEYCLOAK_REALM || 'meet',
  clientId: process.env.PORTAL_CLIENT_ID || 'openvisio-portal',
  clientSecret: process.env.PORTAL_CLIENT_SECRET || '',
  redirectUri: `${PORTAL_BASE}/api/portal/callback`,
};
const kcUrl = (path) => `${KC.base}/realms/${KC.realm}/protocol/openid-connect/${path}`;
const kcConfigured = () => Boolean(KC.base);

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkcePair = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
};

const openvisio = new OpenvisioServer({ proxyUrl: PROXY_URL, apiKey: OPENVISIO_API_KEY });

// URL of the published browser bundle — overridable via .env so the demo can target
// any version / mirror. Default: esm.sh serves the published npm package directly.
const SDK_BROWSER_URL =
  process.env.SDK_BROWSER_URL || 'https://esm.sh/@openvisio/sdk-js@2.0.1/browser';

const app = express();
app.use(express.json());
app.use(express.static(join(here, 'public')));

// Runtime config exposed to the page — lets the frontend load the SDK from the
// configured CDN URL (without baking the version into the static HTML).
app.get('/api/config', (_req, res) =>
  res.json({ openvisioUrl: OPENVISIO_URL, sdkBrowserUrl: SDK_BROWSER_URL }));

// ── Sessions — the portal's own authz state (in-memory; a real portal uses a store) ──

// `username` = who the user is to the portal (null = not logged in → guest).
// The meeting context (role/roomName/userId) is attached on join.
const sessions = new Map();      // sid → { username, accessToken, role, roomName, slug, userId }

const parseCookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k),
  );

const loadSession = (req) => sessions.get(parseCookies(req).sid);

function ensureSession(req, res) {
  let s = loadSession(req);
  if (!s) {
    const sid = randomUUID();
    s = { username: null };
    sessions.set(sid, s);
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  return s;
}

// ── Portal authentication — real Keycloak Authorization Code + PKCE (BFF) ────────
// The backend drives the flow and exchanges the code for tokens server-side; the
// browser only ever holds an opaque session cookie. Identity comes from Keycloak's
// userinfo endpoint, never from the client.

// 1. Kick off login: redirect the browser to Keycloak with a PKCE challenge.
app.get('/api/portal/login', (req, res) => {
  if (!kcConfigured()) return res.status(500).send('KEYCLOAK_URL is not configured');
  const s = ensureSession(req, res);
  const { verifier, challenge } = pkcePair();
  s.pkceVerifier = verifier;
  s.oauthState = b64url(randomBytes(16));
  const url = new URL(kcUrl('auth'));
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: KC.clientId,
    redirect_uri: KC.redirectUri,
    scope: 'openid profile email',
    state: s.oauthState,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  res.redirect(url.toString());
});

// 2. Keycloak redirects back here with ?code — exchange it for tokens server-side.
app.get('/api/portal/callback', async (req, res) => {
  try {
    const s = loadSession(req);
    if (!s?.pkceVerifier) return res.status(400).send('no pending login');
    if (req.query.error) return res.status(400).send(`Keycloak error: ${req.query.error_description || req.query.error}`);
    if (req.query.state !== s.oauthState) return res.status(400).send('state mismatch');

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: req.query.code,
      redirect_uri: KC.redirectUri,
      client_id: KC.clientId,
      code_verifier: s.pkceVerifier,
    });
    if (KC.clientSecret) form.set('client_secret', KC.clientSecret);

    const tokenRes = await fetch(kcUrl('token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!tokenRes.ok) return res.status(502).send(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const tokens = await tokenRes.json();

    // Verified identity straight from Keycloak (not decoded client-side).
    const userinfo = await fetch(kcUrl('userinfo'), {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }).then((r) => r.json());

    s.username = userinfo.preferred_username || userinfo.email || userinfo.sub;
    s.idToken = tokens.id_token;
    s.accessToken = tokens.access_token;   // forwarded to the proxy → create/resolve as the user
    delete s.pkceVerifier;
    delete s.oauthState;
    res.redirect('/');
  } catch (e) {
    res.status(500).send('login failed: ' + e.message);
  }
});

// 3. RP-initiated logout — clear the local session, then end the Keycloak session.
app.get('/api/portal/logout', (req, res) => {
  const s = loadSession(req);
  const idToken = s?.idToken;
  // Clear EVERY auth artifact: username (identity), idToken (Keycloak logout hint), and
  // accessToken (forwarded to the proxy on resolve/create). Leaving accessToken around
  // makes the next resolve forward an invalid bearer and earn a 502 from the proxy.
  if (s) { s.username = null; delete s.idToken; delete s.accessToken; }
  if (kcConfigured() && idToken) {
    const url = new URL(kcUrl('logout'));
    url.search = new URLSearchParams({
      post_logout_redirect_uri: PORTAL_BASE,
      id_token_hint: idToken,
      client_id: KC.clientId,
    }).toString();
    return res.redirect(url.toString());
  }
  res.redirect('/');
});

app.get('/api/portal/me', (req, res) => res.json({ username: loadSession(req)?.username ?? null }));

const requireLogin = (req, res, next) => {
  const s = loadSession(req);
  if (!s?.username) return res.status(401).json({ error: 'login required to create a room' });
  req.session = s;
  next();
};

const requireSession = (req, res, next) => {
  const s = loadSession(req);
  if (!s?.roomName) return res.status(401).json({ error: 'join a room first' });
  req.session = s;
  next();
};

// The whole point: the portal decides who may moderate, BEFORE calling the proxy.
const requireAdmin = (req, res, next) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden — only the room creator (admin) may do this' });
  }
  next();
};

// Wrap async handlers so a thrown OpenvisioError -> JSON with its proxy status.
const h = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(e.status ?? 500).json({ error: e.message }));

// ── Room lifecycle ────────────────────────────────────────────────────────────

// Host — create a room (LOGIN REQUIRED). The creator owns it → admin.
// Token-based join: the iframe carries ?access_token, so the LiveKit identity
// IS the user_id we mint here — no SSO popup, no identity guessing.
app.get('/api/openvisio/bootstrap', requireLogin, h(async (req, res) => {
  const { username, accessToken } = req.session;
  // Create AS the user (forward their token) → they own the room on the OpenVisio backend.
  const room = await openvisio.createRoom(undefined, accessToken);
  // New proxy returns is_administrable (the real room role). Old proxy omits it
  // → fall back to "the creator is admin" until the proxy update ships.
  const role = (room.is_administrable ?? true) ? 'admin' : 'guest';
  const displayName = (req.query.displayName || username).toString();
  const userId = `${username}-${randomUUID().slice(0, 6)}`;
  const { token, livekit_url } = await openvisio.createToken(room.room_name, userId, { displayName });
  Object.assign(req.session, { role, roomName: room.room_name, slug: room.slug, userId });
  res.json({ openvisioUrl: OPENVISIO_URL, slug: room.slug, roomName: room.room_name, userId, token, livekitUrl: livekit_url, role, username });
}));

// Guest/join — resolve an existing slug and mint a join token (no login needed).
// Admin comes from the OpenVisio backend room role (is_administrable), checked with
// the user's token. A guest may pass a display name; a logged-in user forwards their token.
//
// Resilience: if a stale accessToken sneaks in (expired session, etc.), the OpenVisio
// backend rejects it with 401 and the proxy bubbles that up as a 502 with detail
// "Meet backend returned 401" (the proxy's literal error string — kept as-is to match).
// We detect that, drop the bad token from the session, and retry the resolve as an
// anonymous guest — so a stale login never blocks a public-room join.
const looksLikeStaleBearer = (e) =>
  e?.status === 502 && typeof e?.body?.detail === 'string'
  && /Meet backend returned 401/i.test(e.body.detail);

app.get('/api/openvisio/resolve/:slug', h(async (req, res) => {
  const s = ensureSession(req, res);
  const headerBearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || undefined;
  const bearer = s.accessToken || headerBearer;   // logged-in token, else a manually pasted one
  let resolved;
  try {
    resolved = await openvisio.resolveRoom(req.params.slug, bearer);
  } catch (e) {
    if (!bearer || !looksLikeStaleBearer(e)) throw e;
    // The forwarded bearer is no good — clear the session token and retry as guest.
    delete s.accessToken;
    s.username = null;
    console.warn(`resolve: stale bearer dropped, retrying as guest (slug=${req.params.slug})`);
    resolved = await openvisio.resolveRoom(req.params.slug);
  }
  // Real room role; if the proxy doesn't return it yet, a joiner defaults to guest.
  const role = (resolved.is_administrable ?? false) ? 'admin' : 'guest';
  const who = s.username || 'guest';
  const displayName = (req.query.displayName || s.username || 'Guest').toString();
  const userId = `${who}-${randomUUID().slice(0, 6)}`;
  const { token, livekit_url } = await openvisio.createToken(resolved.room_name, userId, { displayName });
  Object.assign(s, { role, roomName: resolved.room_name, slug: resolved.slug, userId });
  res.json({ ...resolved, roomName: resolved.room_name, openvisioUrl: OPENVISIO_URL, userId, token, livekitUrl: livekit_url, role, username: s.username ?? null });
}));

// Discover the real participant identities in the caller's room.
app.get('/api/openvisio/rooms', requireSession, h(async (req, res) => {
  const rooms = await openvisio.listRooms();
  res.json(rooms.filter((r) => r.room_name === req.session.roomName));
}));

// Leave — the browser destroys the iframe first (no banner), this is the cleanup.
// Target the real LiveKit identity (from the participant list), falling back to the
// minted one. Under iframe SSO the participant identity is the user's identity-provider
// identity, not the token id we minted, so the client passes the discovered identity.
app.post('/api/openvisio/leave', requireSession, h(async (req, res) =>
  res.json(await openvisio.leave(req.session.roomName, req.body.userId || req.session.userId))));

// ── Participant-targeted actions — roomName comes from the session, never the client ──

const interactionActions = {
  'interactions/mic-mute':       (r, u) => openvisio.interactions.muteMic(r, u),
  'interactions/mic-unmute':     (r, u) => openvisio.interactions.unmuteMic(r, u),
  'interactions/camera-disable': (r, u) => openvisio.interactions.disableCamera(r, u),
  'interactions/camera-enable':  (r, u) => openvisio.interactions.enableCamera(r, u),
};

const moderationActions = {
  'moderation/mic-mute':          (r, u) => openvisio.moderation.muteMic(r, u),
  'moderation/mic-unmute':        (r, u) => openvisio.moderation.unmuteMic(r, u),
  'moderation/camera-disable':    (r, u) => openvisio.moderation.disableCamera(r, u),
  'moderation/camera-enable':     (r, u) => openvisio.moderation.enableCamera(r, u),
  'moderation/screen-share-stop': (r, u) => openvisio.moderation.stopScreenShare(r, u),
  'moderation/kick':              (r, u) => openvisio.moderation.kick(r, u),
};

// Interactions are soft + reversible → any participant. Body: { userId } (the target).
for (const [path, fn] of Object.entries(interactionActions)) {
  app.post(`/api/openvisio/${path}`, requireSession, h(async (req, res) =>
    res.json(await fn(req.session.roomName, req.body.userId))));
}

// Moderation is irreversible → ADMIN ONLY, enforced here before the proxy is called.
for (const [path, fn] of Object.entries(moderationActions)) {
  app.post(`/api/openvisio/${path}`, requireSession, requireAdmin, h(async (req, res) =>
    res.json(await fn(req.session.roomName, req.body.userId))));
}

app.post('/api/openvisio/interactions/raise-hand', requireSession, h(async (req, res) =>
  res.json(await openvisio.interactions.raiseHand(req.session.roomName, req.body.userId, req.body.raised))));

app.post('/api/openvisio/interactions/reaction', requireSession, h(async (req, res) =>
  res.json(await openvisio.interactions.reaction(req.session.roomName, req.body.reaction))));

app.post('/api/openvisio/interactions/chat', requireSession, h(async (req, res) =>
  res.json(await openvisio.interactions.chat(req.session.roomName, req.body.message))));

// ── Recording & transcription — host powers, ADMIN ONLY. egress_id tracked per room ──

const egress = new Map(); // `${kind}:${roomName}` → egress_id

const startEgress = (kind, start) => h(async (req, res) => {
  // The proxy validates that user_id is a live participant — use the real identity
  // (from the participant list) sent by the client, not the minted token id.
  const userId = req.body.userId || req.session.userId;
  const info = await start(req.session.roomName, userId);
  egress.set(`${kind}:${req.session.roomName}`, info.egress_id);
  res.json(info);
});

const stopEgress = (kind, stop) => h(async (req, res) => {
  const key = `${kind}:${req.session.roomName}`;
  const id = egress.get(key);
  if (!id) throw Object.assign(new Error(`no active ${kind} for this room`), { status: 409 });
  const result = await stop(id);
  egress.delete(key);
  res.json(result);
});

app.post('/api/openvisio/recording/start',     requireSession, requireAdmin, startEgress('recording', (r, u) => openvisio.startRecording(r, u)));
app.post('/api/openvisio/recording/stop',      requireSession, requireAdmin, stopEgress('recording', (id) => openvisio.stopRecording(id)));
app.post('/api/openvisio/transcription/start', requireSession, requireAdmin, startEgress('transcription', (r, u) => openvisio.startTranscription(r, u)));
app.post('/api/openvisio/transcription/stop',  requireSession, requireAdmin, stopEgress('transcription', (id) => openvisio.stopTranscription(id)));

createServer(app).listen(PORT, () => {
  console.log(`openvisio-sdk-js-sample on http://localhost:${PORT}  (proxy: ${PROXY_URL})`);
});
