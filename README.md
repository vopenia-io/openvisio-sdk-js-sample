# openvisio-sdk-js-sample

Official sample app for [`@openvisio/sdk-js`](https://www.npmjs.com/package/@openvisio/sdk-js).
A Node/Express backend that holds the API key (`server.mjs`) plus a single-page
frontend that renders the call (`public/index.html`).

It ships **two frontend flows you can toggle live**:

- **Headless (default)** — no iframe, no SSO popup. The page connects to LiveKit
  directly with the proxy-minted token via `livekit-client` and renders the tiles
  itself. Self mic/cam/screen and animated reactions are done client-side;
  moderation/recording go through the backend.
- **Iframe (toggle)** — loads `OpenvisioBrowser` from the **published**
  `@openvisio/sdk-js` package via the esm.sh CDN mirror, then mounts the
  OpenVisio web app inside the page. This is the demo that proves the
  npm-published browser bundle works end-to-end.

```
browser (index.html)              backend (server.mjs)             OpenVisio proxy
  OIDC login (PKCE)   ───────▶   /api/portal/*  ────────────────▶  identity provider
  livekit-client      ◀── token  /api/openvisio/* (OpenvisioServer) ▶  REST API
        │                                                              │
        └──────────── media (WebRTC) ────────────────────────────▶ LiveKit server

  (or) iframe via OpenvisioBrowser ◀── browser bundle from esm.sh CDN
       mounts the OpenVisio web app inside #openvisio-container
```

The default is **headless** because embedding the OpenVisio web app drags in its
own OIDC flow and a `SameSite=None` session cookie — fragile and increasingly
blocked by browsers. The iframe toggle exists specifically to demonstrate the
published `OpenvisioBrowser` class.

## Run

```bash
# 1. Configure
cp .env.example .env && $EDITOR .env

# 2. Install (pulls @openvisio/sdk-js from npm) and start
npm install && npm start          # -> http://localhost:4000
```

Open http://localhost:4000.

> **Local SDK during development** — if you want to point at a *local* checkout
> of `@openvisio/sdk-js` instead of the published version, run
> `npm install ../openvisio-sdk-js` from this folder (after `npm run build` in
> the SDK). The default points at the npm registry.

## Authorization model

You must be **logged in to create** a room; the creator owns it and is the
**admin**. Without logging in (or when joining a room you don't own) you can
only **join as a guest**, with no moderation/recording powers. Admin is enforced
server-side: the portal returns 403 on moderation/recording for non-owners,
before the proxy is ever called — exactly as the SDK README states authz is
your application's job.

Login is a **real OIDC** flow (Authorization Code + PKCE, BFF pattern): the
backend redirects to the identity provider, exchanges the code for tokens
server-side, and reads the identity from the `userinfo` endpoint. The browser
only holds an opaque session cookie.

> **Identity provider setup required** — the portal client (realm `meet`) must
> whitelist this sample's URIs:
> - Valid redirect URI: `http://localhost:4000/api/portal/callback`
> - Valid post-logout redirect URI: `http://localhost:4000`
>
> If the portal client is *confidential*, also set `PORTAL_CLIENT_SECRET` in
> `.env`.

Two ways to enter a meeting:

- **(1) Create room & join (host)** — *requires login*. Creates the room, you
  own it → the admin/moderation/recording buttons show.
- **(2) Join existing** — paste a slug or full OpenVisio URL. The backend
  resolves it to the room UUID and connects to LiveKit; no login needed for a
  public room. You get admin **only** if you are the logged-in creator of that
  room; otherwise you join as a guest.

  For a **private** room, paste an OIDC bearer in the bearer field — it is
  forwarded to the proxy's `resolve` endpoint (and on to the OpenVisio backend)
  via the `Authorization` header. A bad/expired bearer makes the OpenVisio
  backend reject the resolve with 401 — leave the field empty for public rooms.

## Demonstrating the published SDK

The page fetches `/api/config` at startup to learn which CDN URL to load the SDK
from (`SDK_BROWSER_URL`, default `https://esm.sh/@openvisio/sdk-js@2.0.1/browser`).

- **Iframe toggle off (default):** the SDK browser bundle is *not* loaded; the
  page goes straight to `livekit-client`. This still proves the *server* SDK
  (`OpenvisioServer`) is in use, since every backend call goes through it.
- **Iframe toggle on:** clicking **Create** or **Join existing** triggers
  `import(sdkBrowserUrl)` and instantiates `OpenvisioBrowser`. Open DevTools →
  Network: you'll see `browser` (the ESM module) fetched from esm.sh, then the
  OpenVisio iframe mounted into `#openvisio-container` with the access token
  from the backend.

To pin a different version or mirror, override `SDK_BROWSER_URL` in `.env`:

```env
# unpkg or jsdelivr work too
SDK_BROWSER_URL=https://unpkg.com/@openvisio/sdk-js@2.0.1/dist/browser.js
```

## Buttons

| Group | Where it runs | Notes |
|---|---|---|
| **My devices** (mute · cam · share · react) | **client-side**, `livekit-client` | self-actions never go through the proxy; client-side reaction animates on tiles |
| **Interactions on target** (mic/cam · hand · chat) | proxy `interactions.*` | soft, reversible; targets the selected participant |
| **Moderation** (force mute/cam · screen · kick) | proxy `moderation.*`, **admin only** | irreversible; blocked server-side (403) for guests |
| **Recording / Transcription** | proxy, **admin only** | `egress_id` tracked server-side |
| **Room** (leave) | `room.disconnect()` + proxy `leave` (or iframe leave + proxy `leave`) | client-initiated disconnect, then server cleanup |

Notes:
- The target dropdown is populated **from the LiveKit room itself** (local +
  remote participants) — no identity guessing, since the backend minted every token.
- Mic/cam actions on a target return **404** until that participant has
  published the track; recording/transcription **stop** returns **409** if
  nothing is running. Both are expected — the detail comes straight from the proxy.
- The **My devices** controls and per-participant action buttons only operate
  on the headless flow's `livekit-client` state; in iframe mode, use the
  OpenVisio UI inside the iframe for self-actions.

> Sample intended for development and demo against a staging proxy. Do not
> point it at production.
