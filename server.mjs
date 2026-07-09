// A faithful integrator-portal stand-in for the OpenVisio api proxy.
//
// It calls the proxy through the @openvisio/sdk-js server client (OpenvisioServer).
// Mirrors the proxy's contract: the proxy authenticates the *portal* with a single
// X-Api-Key and trusts it — so, exactly as the proxy README states, "authorization
// logic (who can kick, mute, record) is enforced by the integrator before calling
// this proxy." This backend therefore holds the key, owns sessions, and enforces the
// admin/guest boundary itself (returning 403) before ever touching the proxy.
//
//   cp .env.example .env && edit it
//   npm install && npm start  →  http://localhost:4000
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

// The proxy authenticates the portal with a single X-Api-Key. Accept either
// API_KEY (current name) or the legacy MAGO_API_KEY so an older .env keeps working.
const { PROXY_URL, MEET_URL, PORT = 4000 } = process.env;
const API_KEY = process.env.API_KEY || process.env.MAGO_API_KEY;
if (!PROXY_URL || !MEET_URL || !API_KEY) {
  console.error('Missing PROXY_URL / MEET_URL / API_KEY (see .env.example).');
  process.exit(1);
}

// On a private (vRack) cluster LiveKit only has a pod-IP ICE candidate, reachable
// solely through the Stunner TURN relay — handed to the browser so it forces
// relay-only ICE. Without it: "could not establish pc connection".
const { LIVEKIT_TURN_URL, LIVEKIT_TURN_USERNAME, LIVEKIT_TURN_CREDENTIAL } = process.env;
const turn = LIVEKIT_TURN_URL
  ? { url: LIVEKIT_TURN_URL, username: LIVEKIT_TURN_USERNAME, credential: LIVEKIT_TURN_CREDENTIAL }
  : null;

// Keycloak `mago-portal` client — real Authorization Code + PKCE login (BFF pattern).
const PORTAL_BASE = (process.env.PORTAL_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const KC = {
  base: (process.env.KEYCLOAK_URL || '').replace(/^(?!https?:\/\/)/, 'https://').replace(/\/+$/, ''),
  realm: process.env.KEYCLOAK_REALM || 'meet',
  clientId: process.env.PORTAL_CLIENT_ID || 'mago-portal',
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

const meet = new OpenvisioServer({ proxyUrl: PROXY_URL, apiKey: API_KEY });

const app = express();
app.use(express.json());
app.use(express.static(join(here, 'public')));

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
  if (s) { s.username = null; delete s.idToken; }
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

// Wrap async handlers so a thrown MagoMeetError → JSON with its proxy status.
const h = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(e.status ?? 500).json({ error: e.message }));

// ── Room lifecycle ────────────────────────────────────────────────────────────

// Host — create a room (LOGIN REQUIRED). The creator owns it → admin.
// Token-based join (README steps 1-4): the iframe carries ?access_token, so the
// LiveKit identity IS the user_id we mint here — no SSO popup, no identity guessing.
app.get('/api/meet/bootstrap', requireLogin, h(async (req, res) => {
  const { username, accessToken } = req.session;
  // Create AS the user (forward their token) → they own the room on the meet backend.
  const room = await meet.createRoom(undefined, accessToken);
  // New proxy returns is_administrable (the real Meet room role). Old/undeployed proxy
  // omits it → fall back to "the creator is admin" until the proxy update ships.
  const role = (room.is_administrable ?? true) ? 'admin' : 'guest';
  const displayName = (req.query.displayName || username).toString();
  const userId = `${username}-${randomUUID().slice(0, 6)}`;
  const { token, livekit_url } = await meet.createToken(room.room_name, userId, { displayName });
  Object.assign(req.session, { role, roomName: room.room_name, slug: room.slug, userId });
  res.json({ meetUrl: MEET_URL, slug: room.slug, roomName: room.room_name, userId, token, livekitUrl: livekit_url, role, username, turn });
}));

// Guest/join — resolve an existing slug and mint a join token (no login needed).
// Admin comes from the meet backend room role (is_administrable), checked with the user's
// token. A guest may pass a display name; a logged-in user forwards their token.
app.get('/api/meet/resolve/:slug', h(async (req, res) => {
  const s = ensureSession(req, res);
  const headerBearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || undefined;
  const bearer = s.accessToken || headerBearer;   // logged-in token, else a manually pasted one
  const resolved = await meet.resolveRoom(req.params.slug, bearer);
  // Real Meet room role; if the proxy doesn't return it yet, a joiner defaults to guest.
  const role = (resolved.is_administrable ?? false) ? 'admin' : 'guest';
  const who = s.username || 'guest';
  const displayName = (req.query.displayName || s.username || 'Guest').toString();
  const userId = `${who}-${randomUUID().slice(0, 6)}`;
  const { token, livekit_url } = await meet.createToken(resolved.room_name, userId, { displayName });
  Object.assign(s, { role, roomName: resolved.room_name, slug: resolved.slug, userId });
  res.json({ ...resolved, roomName: resolved.room_name, meetUrl: MEET_URL, userId, token, livekitUrl: livekit_url, role, username: s.username ?? null, turn });
}));

// Discover the real participant identities in the caller's room.
app.get('/api/meet/rooms', requireSession, h(async (req, res) => {
  const rooms = await meet.listRooms();
  res.json(rooms.filter((r) => r.room_name === req.session.roomName));
}));

// Leave — the browser destroys the iframe first (no banner), this is the cleanup.
// Target the real LiveKit identity (from the participant list), falling back to the
// minted one. Under Meet SSO the participant identity is the user's Keycloak identity,
// not the token id we minted, so the client passes the discovered identity.
app.post('/api/meet/leave', requireSession, h(async (req, res) =>
  res.json(await meet.leave(req.session.roomName, req.body.userId || req.session.userId))));

// ── Participant-targeted actions — roomName comes from the session, never the client ──

const interactionActions = {
  'interactions/mic-mute':       (r, u) => meet.interactions.muteMic(r, u),
  'interactions/mic-unmute':     (r, u) => meet.interactions.unmuteMic(r, u),
  'interactions/camera-disable': (r, u) => meet.interactions.disableCamera(r, u),
  'interactions/camera-enable':  (r, u) => meet.interactions.enableCamera(r, u),
};

const moderationActions = {
  'moderation/mic-mute':          (r, u) => meet.moderation.muteMic(r, u),
  'moderation/mic-unmute':        (r, u) => meet.moderation.unmuteMic(r, u),
  'moderation/camera-disable':    (r, u) => meet.moderation.disableCamera(r, u),
  'moderation/camera-enable':     (r, u) => meet.moderation.enableCamera(r, u),
  'moderation/screen-share-stop': (r, u) => meet.moderation.stopScreenShare(r, u),
  'moderation/kick':              (r, u) => meet.moderation.kick(r, u),
};

// Interactions are soft + reversible → any participant. Body: { userId } (the target).
for (const [path, fn] of Object.entries(interactionActions)) {
  app.post(`/api/meet/${path}`, requireSession, h(async (req, res) =>
    res.json(await fn(req.session.roomName, req.body.userId))));
}

// Moderation is irreversible → ADMIN ONLY, enforced here before the proxy is called.
for (const [path, fn] of Object.entries(moderationActions)) {
  app.post(`/api/meet/${path}`, requireSession, requireAdmin, h(async (req, res) =>
    res.json(await fn(req.session.roomName, req.body.userId))));
}

app.post('/api/meet/interactions/raise-hand', requireSession, h(async (req, res) =>
  res.json(await meet.interactions.raiseHand(req.session.roomName, req.body.userId, req.body.raised))));

app.post('/api/meet/interactions/reaction', requireSession, h(async (req, res) =>
  res.json(await meet.interactions.reaction(req.session.roomName, req.body.reaction))));

app.post('/api/meet/interactions/chat', requireSession, h(async (req, res) =>
  res.json(await meet.interactions.chat(req.session.roomName, req.body.message))));

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

app.post('/api/meet/recording/start',     requireSession, requireAdmin, startEgress('recording', (r, u) => meet.startRecording(r, u)));
app.post('/api/meet/recording/stop',      requireSession, requireAdmin, stopEgress('recording', (id) => meet.stopRecording(id)));
app.post('/api/meet/transcription/start', requireSession, requireAdmin, startEgress('transcription', (r, u) => meet.startTranscription(r, u)));
app.post('/api/meet/transcription/stop',  requireSession, requireAdmin, stopEgress('transcription', (id) => meet.stopTranscription(id)));

createServer(app).listen(PORT, () => {
  console.log(`e2e on http://localhost:${PORT}  (proxy: ${PROXY_URL})`);
});
