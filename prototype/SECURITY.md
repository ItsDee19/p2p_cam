# Security and bug analysis

Review of the prototype as it stood after the UI rebuild, plus what was changed
in response. Every finding below was reproduced before being fixed, and each has
a regression check in `tools/server-selftest.js` (40 checks, all passing).

**Headline:** the prototype was previously open to anyone who could reach the
port. No authentication existed, the registry endpoint published the UIDs needed
to connect, and the camera answered any request to watch it with zero
interaction on the device. A single malformed URL also killed the server. Both
are fixed.

---

## Threat model

What this thing actually is: a Node process listening on `0.0.0.0` on a Wi-Fi
network, plus two browser pages, one of which holds a live camera and
microphone. It gets carried into client offices and hotel Wi-Fi.

**Assumed hostile:** anyone else on the same network; any web page the operator
happens to have open in another tab; anyone who can see a UID over someone's
shoulder.

**Assumed trusted:** the machine running the server, and the person operating
the phone.

**Out of scope:** an attacker with code execution on either device, or one who
controls the network path enough to forge TLS for an already-trusted CA.

---

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **Critical** | No authentication anywhere. Anyone reaching the port could watch any live camera. | Fixed |
| 2 | **Critical** | Remote denial of service: `GET /%` crashed the process. Unauthenticated, one request. | Fixed |
| 3 | **High** | Peer impersonation: `/api/signal` trusted the `from` field in the request body. | Fixed |
| 4 | **High** | UID squatting: any client could create a room for any UID. | Fixed |
| 5 | **High** | CSRF: POSTs accepted any content type, so a form post from a hostile page reached the relay. | Fixed |
| 6 | **High** | DNS rebinding: no `Host` validation, so a malicious site could address the LAN server as same-origin. | Fixed |
| 7 | Medium | Identifiers came from `Math.random()`, which is predictable from a handful of outputs. | Fixed |
| 8 | Medium | Resource exhaustion: unbounded connections, rooms, and signalling rate. | Fixed |
| 9 | Medium | No CSP, no anti-framing, no `nosniff`, no referrer policy. | Fixed |
| 10 | Low | Static path check used a bare `startsWith`, so a sibling directory named `publicXYZ` would have matched. | Fixed |
| 11 | Low | Request bodies were unbounded until parse time. | Fixed |
| B1 | Bug | Camera restart left connected viewers dark forever. | Fixed |
| B2 | Bug | Peer connections leaked on renegotiation and on `disconnected`. | Fixed |
| B3 | Bug | Viewer audio started unmuted while the button read "Listen" — instant feedback howl. | Fixed |
| B4 | Bug | `ReferenceError` introduced during hardening hung every answer relay. | Fixed |

---

## The critical ones, in detail

### 1 — Anyone on the network could watch any camera

The UID was the only thing resembling a secret, and `/api/cameras` published
every online UID to any caller. The camera then sent an offer to any viewer that
joined, with no confirmation on the device. The whole chain was:

```
GET /api/cameras          ->  {"cameras":[{"uid":"LESSAI-297061-ATV", ...}]}
open /viewer.html, paste that UID, press Connect  ->  live video and audio
```

Zero interaction on the phone, no credential, no prompt.

**Fixed** with pairing. The camera mints a six-digit PIN per session and shows it
on the device screen; it registers under `sha256(uid + ':' + PIN)`. A viewer must
present the same hash to open an event stream or to signal. Comparison is
constant-time. The PIN itself never leaves the device — only the hash does — and
the server stores only the hash.

Listing is deliberately kept, because it makes the demo pleasant and because the
UID was never the secret. It now reveals only that a UID exists.

### 2 — One request killed the server

`decodeURIComponent()` throws `URIError` on a malformed escape, and the call sat
in the request handler with nothing above it. Reproduced against the running
server:

```
GET /%   ->  connection reset, process exits with code 1
```

**Fixed** three ways, because any one of them alone is fragile:

- the decode is now guarded and returns `400`;
- the whole dispatch is wrapped so a throw yields `500`, not a hang — surviving
  is not sufficient if the client is left waiting forever;
- `uncaughtException` / `unhandledRejection` handlers log and keep serving.

`headersTimeout`, `requestTimeout` and `keepAliveTimeout` are set so half-open
requests cannot park sockets.

### 3 — Peer impersonation

`handleSignal` took `msg.from` straight from the body and never checked it
against a live connection. Anyone who could reach the relay could post an offer
claiming to be the camera and capture the viewer's session.

**Fixed** with a per-connection bearer token: 24 random bytes, generated on join
and delivered *only* down that peer's own SSE stream. Every POST must carry it,
and it is matched against the claimed `from` in constant time. Because a
cross-origin page cannot read an `EventSource` body, this closes impersonation
and CSRF with one mechanism.

### 4 — UID squatting

Rooms were created on demand for whoever asked first. Once pairing exists, that
becomes a way to pre-register a victim's UID with the attacker's own secret and
lock the real camera out. **Fixed:** only `role=camera` creates a room, a second
camera on a live UID gets `409`, and when the camera leaves the room is torn down
along with its viewers rather than being left orphaned with a stale secret.

---

## Hardening added

**Authentication and authorisation**
- PIN pairing on every join, constant-time comparison
- Per-connection bearer token required on every signalling POST
- Only cameras create rooms; viewers may not signal each other
- Signal `type` restricted to `offer` / `answer` / `ice`; UID and client-id formats validated

**Brute force**
- Per-IP: 10 failed attempts per minute, then `429`
- Per-camera: 20 failures in 5 minutes locks that camera out entirely — the per-IP
  limit alone is weak on a LAN where changing source address is trivial
- `/api/check` gives the viewer a real error instead of `EventSource` retrying
  against a `403` forever, which was itself an accidental guessing loop
- The client gives up after 4 failed stream attempts

**Origin and transport**
- `Host` allowlist (localhost plus the machine's own LAN addresses) → `421`
- Cross-origin POST refused; `content-type: application/json` required
- CSP with a **per-response script nonce** — no `unsafe-inline`, `default-src 'none'`
- `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `no-referrer`,
  `Permissions-Policy` limiting camera and microphone to same-origin
- TLS private key written `0600`

**Resource limits**
- 50 rooms, 8 peers per room, 120 connections, 256 KB bodies, 150 signals per
  10 s per peer
- Oversized bodies get a clean `413` with `Connection: close` rather than a
  socket reset, so the client learns why

**Randomness**
- `crypto.getRandomValues` with rejection sampling for UIDs, PINs and client ids
- Verified uniform: 60,000 draws of `randomBelow(10)` spread 297; 2,992 distinct
  PINs in 3,000
- Browser `pairHash` verified byte-identical to the server's `sha256`

**Injection**
- No `innerHTML` anywhere user- or peer-controlled data reaches; the one
  interpolated error message now builds nodes with `textContent`
- Path traversal blocked, checked with a separator-aware prefix comparison

---

## Residual risk — read this before demoing on someone else's network

These are **not fixed**, by design or by scope. They are why this is a prototype.

1. **The certificate is self-signed and unpinned.** You are training whoever
   watches to click through a browser warning. Someone on the same network who
   can answer first could present their own certificate and both devices would
   accept it just as readily. The `Host` allowlist limits this but does not
   remove it.

2. **A malicious control plane could still MITM the media.** WebRTC always
   encrypts with DTLS-SRTP, but the fingerprints that bootstrap it travel through
   this server. A compromised server could substitute its own and sit in the
   middle. The media path being peer-to-peer does not by itself prevent this.
   The real answer is the per-unit key pair burned at PCB flashing described in
   section 04 of the proposal, with the app pinning the device key rather than
   trusting whatever the server relays. **This is worth saying out loud to
   Sanjay** — it is precisely why "no cloud" is not the same as "secure", and it
   is the argument for controlling the manufacturing step.

3. **A six-digit PIN is 10⁶.** That is only adequate because of the lockouts.
   A shipped product uses device keys, not a shared code.

4. **The PIN is shared, not per-viewer.** There is no way to revoke one viewer
   without rotating the PIN and dropping everyone.

5. **No transport confidentiality between browser tabs on the same machine**, no
   audit log, no account model, no device ownership. None of that exists yet.

6. **`--no-auth` still exists** as an escape hatch for a captive demo. It prints
   a loud warning. Do not use it on a network you do not own.

7. **The server runs as your user with no sandboxing** and serves everything
   under `public/`.

---

## Where this maps in the proposal

The prototype now demonstrates the *shape* of the right answer — pairing before
access, per-session tokens, constant-time comparison, rate limiting, a control
plane that carries no media — while making clear that the actual product needs
device identity in silicon.

That is the Phase 1 and Phase 2 security work in section 04: per-unit key pairs
burned at flashing, signed firmware and secure OTA, no shared default
credentials, and end-to-end keys the server never sees. The in-house PCB assembly
is what makes that possible, and remains the strongest technical argument in
the pitch.

---

## Running the checks

```bash
node tools/server-selftest.js
```

Covers pairing, signalling integrity, impersonation, CSRF, DNS rebinding,
crash resistance, header policy, rate limiting and lockout, plus lifecycle. Any
regression on the findings above fails the suite.
