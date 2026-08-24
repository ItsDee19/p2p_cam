# P2P Camera — Android app

Native Android client for the prototype. Same peer-to-peer architecture as the
web version, same signalling protocol, same pairing scheme — so an Android
camera can be watched from a laptop browser and vice versa.

This is **not a WebView wrapper**. It uses the native WebRTC stack
(`io.github.webrtc-sdk:android`), Camera2 capture and hardware video encoding —
the same media path a shipped product would use.

---

## Build

```bash
cd D:\p2p_cam\android && gradlew assembleDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`.

Install it on a phone with USB debugging on:

```bash
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

Or just open the `android` folder in Android Studio and press Run.

### About the SDK version

`compileSdk` is **31**, because android-31 is the only platform installed on
this machine. That constraint also rules out modern Jetpack Compose (1.3+ needs
compileSdk 33), so the UI is built with Views. Both are one-line changes once a
newer platform is installed through Android Studio's SDK Manager — nothing in
the app code depends on staying at 31.

---

## Running it

Start the prototype server on the laptop. **Plain HTTP is the recommended
mode for the app:**

```bash
cd D:\p2p_cam\prototype && node server.js --http
```

A native app has no "secure context" rule, so unlike a browser it does not need
TLS to open the camera. That removes the certificate warning entirely — the
single most awkward step in the web demo.

Then in the app:

1. Enter the control plane address, e.g. `http://192.168.0.111:8099`
   (the scheme may be omitted; `192.168.0.111:8099` works).
2. Pick a role.

| Role | What it does |
|---|---|
| **Be the camera** | Publishes this phone's lens and microphone. Shows a UID and a fresh 6-digit PIN. |
| **Watch a camera** | Pairs by UID + PIN, renders the feed, talks back, and can trigger a still to be saved on the camera. |

### Mixing with the web client

Both directions work, because the app speaks the same protocol:

- Android camera → laptop browser viewer
- Web camera (phone browser) → Android viewer

If you point the app at an **`https://`** server with the prototype's
self-signed certificate, tick **Accept self-signed certificate** on the home
screen. That disables certificate validation for the app's own HTTP client and
is prototype-only — see `../prototype/SECURITY.md`.

---

## Design

Deliberately minimal, and futuristic by geometry rather than by decoration:

- **Zero corner radius everywhere.** Sharp rectangles read as instrument, not
  consumer app; this single choice does most of the work.
- **Two signal colours only** — red is media and recording, teal is the control
  plane. Identical meaning to the proposal and the web UI.
- **Monospaced numerics** with tabular spacing for every readout, and uppercase
  widely tracked labels for every caption.
- **Viewfinder brackets** over the video surface — the one decorative element,
  and it earns its place because it depicts what the screen actually is. It
  sweeps a thin line while negotiating, goes teal when paired, red when live.
- **No glow, no gradients, no glassmorphism.** Hairlines and negative space
  instead.

Nothing renders below 11sp.

---

## Known limits

- **Torch is reported as unsupported.** The WebRTC capturer does not expose it;
  driving it needs a direct Camera2 handle held alongside the capture session.
  The command round-trips and answers honestly rather than silently doing
  nothing.
- **Background streaming works, but only while the app lives.** A foreground
  service (with a persistent "Camera live" notification) holds camera and
  microphone access when the app is off screen — without it Android revokes
  both the moment you switch away, which for a monitoring camera is the normal
  case. It does not yet survive the process being killed or a reboot.
- **One camera per viewer screen**, no multi-camera grid yet.
- **The pairing PIN is a prototype stand-in** for the per-unit key pair burned
  at PCB flashing described in section 04 of the proposal.

---

## Verified on device

Run against the Android emulator (Pixel 4, API 30) with two installed copies —
`ai.less.p2pcam.debug` as the camera and `ai.less.p2pcam.debugB` as the viewer,
which is the only way to exercise a real peer connection when nothing outside
can route back to the device.

| Check | Result |
|---|---|
| Install, launch, navigate | No crashes; all three screens render |
| Camera capture | Camera2 session opens, preview renders |
| UID + PIN | `LESSAI-027315-WUY`, PIN minted per session |
| Pairing hash interop | App's `sha256(uid:PIN)` accepted by the Node server |
| Wrong PIN | Refused — "pairing refused: wrong PIN" |
| Signalling | offer → answer → ICE, both sides report `connected` |
| **Live video** | 640×360, 67 kb/s, 20 ms RTT, 0 frames dropped |
| Connection path | `DIRECT · LAN` |
| Two-way audio | Camera logs "talk-back audio track received" |
| Data channel | Camera state received; remote capture acked |
| Remote capture | 16,595-byte JPEG written to `/sdcard/Pictures/P2PCam/`, correctly rotated to 720×1280 |
| **Media through server** | **0 bytes**, against 53 KB of signalling |

Reproduce the second instance with:

```bash
gradlew assembleDebug -Pinst=B
```

## Layout

| Path | Role |
|---|---|
| `net/Signal.kt` | SSE down, POST up. Pairing proof and per-connection bearer token, matching the server |
| `net/Crypto.kt` | `sha256(uid + ':' + PIN)`, CSPRNG UID and PIN generation |
| `rtc/Rtc.kt` | Shared `PeerConnectionFactory`, and the JSON shapes the browser expects for SDP and ICE |
| `rtc/CameraSession.kt` | This device as camera: capture, offer to each viewer, serve data-channel commands |
| `rtc/ViewerSession.kt` | This device as app: answer, render, talk back, drive the camera |
| `rtc/Stats.kt` | getStats → bitrate, frame size, RTT, and direct-vs-relayed |
| `rtc/FrameCapture.kt` | One video frame → JPEG on the device's own storage |
| `rtc/CaptureService.kt` | Foreground service holding camera and mic while the app is off screen |
| `ui/BracketFrame.kt` | Viewfinder brackets and the negotiating sweep |
