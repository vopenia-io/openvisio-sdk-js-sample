// Guest connection to a platform of a catalog, with an audio/video check.
// No proxy and no API key.
//
//   npm install && CATALOG_URL=<catalog URL> PLATFORM_KEYS=<key>[,<key>…] npm run guest
//   →  http://localhost:4100
//
// Every call to the platform happens here, as in a real integration: Meet platforms send
// no CORS headers. The browser only receives the LiveKit access, once the guest is in.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { MeetGuestClient, fetchPlatformCatalog, platformForRoomUrl } from '@openvisio/sdk-js/server';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.GUEST_PORT || 4100;
// The SDK has nothing built in. This page plays the integrator's configuration:
// - CATALOG_URL: the platform catalog URL the integrator is given (required);
// - PLATFORM_KEYS: the platforms this room may use, comma-separated, as a Mago licence will
//   send them. When none are given, the configuration's default applies: openvisio.
const { CATALOG_URL } = process.env;
if (!CATALOG_URL) {
  console.error('Set CATALOG_URL to the platform catalog URL you were given, e.g.:');
  console.error('  CATALOG_URL=<catalog URL> PLATFORM_KEYS=<key>[,<key>…] npm run guest');
  process.exit(1);
}
const DEFAULT_PLATFORM_KEYS = ['openvisio']; // configuration default, not an SDK one
const PLATFORM_KEYS = (process.env.PLATFORM_KEYS ?? '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const allowedKeys = PLATFORM_KEYS.length ? PLATFORM_KEYS : DEFAULT_PLATFORM_KEYS;

/** Only the allowed platforms of the catalog, in catalog order. */
const catalog = () => fetchPlatformCatalog({ url: CATALOG_URL, allowedKeys });

// One client per allowed platform. A real integration stores the platform key with the
// meeting, and creates its client once.
const clients = new Map();

/**
 * The platform is the chosen key, with a slug or a full URL of that platform. Without a
 * key, it is found from the host of a full room URL, among the allowed platforms only.
 */
async function clientFor(room, platformKey) {
  const allowed = await catalog();
  let platform;
  if (platformKey) {
    platform = allowed.platforms.find((p) => p.key === platformKey);
    if (!platform) throw new TypeError(`"${platformKey}" is not a platform this room may use`);
  } else {
    if (!/^https?:\/\//i.test(room ?? '')) {
      throw new TypeError('Choose a platform to join with a slug, or paste the full room URL.');
    }
    platform = platformForRoomUrl(allowed, room);
    if (!platform) throw new TypeError('This room is not on a platform this room may use.');
  }
  if (!clients.has(platform.key)) {
    clients.set(
      platform.key,
      new MeetGuestClient({ catalogUrl: CATALOG_URL, platformKey: platform.key, allowedPlatformKeys: allowedKeys }),
    );
  }
  return { key: platform.key, meet: clients.get(platform.key) };
}

// entryId → { roomId, displayName, lobbyToken?, livekitToken? }.
// A real integration keeps this in the participant's session. It is keyed per entry here
// so that two tabs of one browser can be two guests, which helps to test media.
const guests = new Map();

/** Keep the lobby token on the server; the browser only gets an opaque entry id. */
function reply(res, entryId, displayName, entry, meet) {
  if (entry.status === 'waiting') {
    guests.set(entryId, { meet, roomId: entry.roomId, displayName, lobbyToken: entry.lobbyToken });
    return res.json({ status: 'waiting', entryId });
  }
  if (entry.status === 'accepted') {
    guests.set(entryId, { meet, roomId: entry.roomId, displayName, livekitToken: entry.livekit.token });
    return res.json({ status: 'accepted', entryId, url: entry.livekit.url, token: entry.livekit.token });
  }
  guests.delete(entryId);
  return res.json({ status: 'denied' });
}

/** Errors carry no token. `status` is 0 when the platform could not be reached. */
const route = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    const status = e instanceof TypeError ? 400 : e.status || 502;
    res.status(status).json({ error: e.message, code: e.code, retryAfter: e.retryAfter });
  });

const app = express();
app.use(express.json());
app.get('/', (_req, res) => res.sendFile(join(here, 'public', 'guest.html')));

app.get('/api/guest/platforms', route(async (_req, res) => {
  const { platforms } = await catalog();
  // The first allowed platform is preselected.
  res.json({
    platforms: platforms.map(({ key, displayName }) => ({ key, displayName: displayName ?? key })),
    preselected: platforms[0]?.key ?? '',
  });
}));

app.post('/api/guest/join', route(async (req, res) => {
  const { room, displayName, platformKey } = req.body;
  const { key, meet } = await clientFor(room, platformKey);
  console.log(`join on platform "${key}"`);
  reply(res, randomUUID(), displayName, await meet.join(room, displayName), meet);
}));

app.post('/api/guest/poll', route(async (req, res) => {
  const guest = guests.get(req.body.entryId);
  if (!guest?.lobbyToken) return res.status(404).json({ error: 'unknown or finished entry' });
  const entry = await guest.meet.pollEntry(guest.roomId, guest.displayName, guest.lobbyToken);
  reply(res, req.body.entryId, guest.displayName, entry, guest.meet);
}));

app.post('/api/guest/raise-hand', route(async (req, res) => {
  const guest = guests.get(req.body.entryId);
  if (!guest?.livekitToken) return res.status(404).json({ error: 'not connected' });
  await guest.meet.raiseHand(guest.roomId, guest.livekitToken, req.body.raised === true);
  res.json({ raised: req.body.raised === true });
}));

app.listen(PORT, 'localhost', () => {
  console.log(`Guest check on http://localhost:${PORT}`);
  console.log(`  catalog: ${CATALOG_URL}`);
  console.log(`  allowed platforms: ${allowedKeys.join(', ')}${PLATFORM_KEYS.length ? '' : ' (default)'}`);
});
