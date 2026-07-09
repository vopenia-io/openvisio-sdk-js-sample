# e2e (scratch)

Throwaway end-to-end demo of `@openvisio/sdk-js` against the **staging** api.
It plays both integrator roles: a backend that holds the API key (`server.mjs`) and a
browser page that renders the call (`public/index.html`).

**Headless integration** — no iframe, no Meet SSO, no third-party cookies. The integrator
connects to LiveKit **directly** with the proxy-minted token (`livekit-client`) and renders
the tiles itself, so the participant identity is the one the integrator controls. The Meet
*app* and its cross-origin auth are bypassed entirely; the proxy's room-control endpoints
still work because they act on the LiveKit room, not on Meet's UI.

```
browser (index.html)                 backend (server.mjs)          api (staging)
  Keycloak login (PKCE) ───────────▶  /api/portal/* ─────────────▶ mago-portal (Keycloak)
  livekit-client ◀── token/url ────   /api/meet/*  (OpenvisioServer) ▶ /api/*
        │                                                            (createToken, etc.)
        └──────────── media (WebRTC) ──────────────────────────────▶ LiveKit server
```

Why headless rather than an iframe: embedding the Meet SPA drags in Meet's own OIDC
(`client_id=meet`, `acr_values=2`) and a `SameSite=None` session cookie — fragile and
increasingly blocked by browsers. Headless removes all of that. Self mic/cam/screen and
animated reactions are done **client-side** via `livekit-client` (the proxy's
server-sent reaction can't animate — here it does).

## Run

```bash
# 1. Configure — API_KEY is in container-registry/api/.env.staging
cp .env.example .env && $EDITOR .env

# 2. Install (pulls @openvisio/sdk-js from the public npm registry) & start
npm install && npm start          # → http://localhost:4000
```

Open http://localhost:4000.

**Authorization model** — you must be **logged in to create** a room; the creator owns it
and is the **admin**. Without logging in (or when joining a room you don't own) you can
only **join as a guest**, with no moderation/recording powers. Admin is enforced
server-side: the portal returns 403 on moderation/recording for non-owners, before the
proxy is ever called — exactly as the proxy README states authz is the integrator's job.

Login is a **real Keycloak** flow (Authorization Code + PKCE, BFF pattern): the backend
redirects to Keycloak, exchanges the code for tokens server-side, and reads the identity
from the `userinfo` endpoint. The browser only holds an opaque session cookie.

> **Keycloak setup required** — the `mago-portal` client (realm `meet`) must whitelist this
> demo's URIs. Ask the Meet admin to add to the `mago-portal` client:
> - Valid redirect URI: `http://localhost:4000/api/portal/callback`
> - Valid post-logout redirect URI: `http://localhost:4000`
>
> If `mago-portal` is a *confidential* client, also set `PORTAL_CLIENT_SECRET` in `.env`.
> (Verified against staging: the realm and the `mago-portal` client already exist, its
> secret is valid, and the localhost redirect URI is accepted.)

Two ways to enter a meeting:

- **① Create room & join (host)** — *requires login*. Creates the room, you own it → the
  admin/moderation/recording buttons show.
- **② Join existing** — paste a slug or full Meet URL. The backend resolves it to the room
  UUID and connects to LiveKit; no login needed for a public room. You get admin **only**
  if you are the logged-in creator of that room; otherwise you join as a guest.

  For a **private** room, paste a Keycloak bearer in the bearer field — it is forwarded to
  the proxy's `resolve` endpoint (and on to the meet backend) via the `Authorization`
  header.
  > A bad/expired bearer makes the meet backend reject the resolve with 401 — leave the
  > field empty for public rooms.

Then exercise the in-meeting actions; each goes browser → backend → proxy.

## Buttons

| Group | Where it runs | Notes |
|---|---|---|
| **My devices** (mute me · cam · share · react) | **client-side**, `livekit-client` | self-actions never go through the proxy; the client-side reaction actually animates |
| **Interactions on target** (mic/cam · hand · chat) | proxy `interactions.*` | soft, reversible; targets the selected participant |
| **Moderation** (force mute/cam · screen · kick) | proxy `moderation.*`, **admin only** | irreversible; blocked server-side (403) for guests |
| **Recording / Transcription** | proxy, **admin only** | `egress_id` tracked server-side |
| **Room** (leave) | `room.disconnect()` + proxy `leave` | client-initiated disconnect, then server cleanup |

Notes:
- The target dropdown is populated **from the LiveKit room itself** (local + remote
  participants) — no identity guessing, since the integrator minted every token.
- Mic/cam actions on a target return **404** until that participant has published the
  track; recording/transcription **stop** returns **409** if nothing is running. Both are
  expected — the detail comes straight from the proxy.

> Staging only — do not point this at prod. It is intentionally outside the build/deploy
> paths (lives in `scratch/`).
