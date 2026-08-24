# P2P camera prototype

A working demonstration of the architecture in section 02 of the proposal: a live
camera feed with two-way audio travelling **directly** between two devices, and a
server that helps them find each other without ever touching the media.

Runs entirely on your own machine and LAN. No npm install, no cloud service, no
external STUN or TURN, no internet connection required.

```bash
node server.js
```

Then open the printed address. It prints both a `localhost` URL for this machine
and a LAN URL for your phone.

---

## What it demonstrates

| Requirement from the meeting | How it shows up here |
|---|---|
| Live feed on Android and iOS | The camera page runs in any modern mobile browser |
| Two-way audio | Camera mic streams out; the viewer's **Talk** button opens a mic back |
| Save images onto the camera hardware | **Save a still on the camera** sends a command down the peer-to-peer data channel; the image is written on the device |
| Peer-to-peer, no cloud | Connection path reads `DIRECT · LAN`, and `media through server` stays at `0 B` |
| UID pairing | Each device mints a `LESSAI-nnnnnn-XXX` UID, persisted like a burned-in identifier |

---

## Running the demo — laptop as viewer, phone as camera

**On the laptop**

1. `node server.js`, then open the printed `https://localhost:<port>/` address.
   Accept the certificate warning.
2. The landing page shows a QR code pointing at the camera page on your LAN IP.

**On the phone** (same Wi-Fi)

3. Scan the QR, or type the LAN URL shown next to it.
4. Accept the certificate warning — **Advanced ▸ Proceed**. Do this before anyone
   is watching; it is the only awkward step.
5. Press **Start**, allow camera and microphone. The phone shows its UID, a red
   LIVE badge, and a **6-digit pairing PIN**.

**Back on the laptop**

6. Open the monitoring app. The phone's UID appears under **UID registry** —
   click it, type the PIN from the phone, press **Connect**. The feed comes up in
   a second or two.
7. `connection path` reads **DIRECT · LAN** and `media through server` stays at
   **0 B** while the bitrate climbs. That is the whole argument, on screen.
8. **Capture on camera** writes a still on the phone from the laptop.
   **Talk** opens your laptop mic and speaks through the phone.
   **Listen** opens the phone's audio on the laptop.

> The viewer starts muted on purpose. If both devices are in the same room,
> pressing **Listen** while the phone's mic is live will howl — use headphones or
> put them in separate rooms.

### Reading the screen

| | |
|---|---|
| **Where the data actually goes** | Red dots animate along the direct path at a speed driven by the real bitrate. The control plane box below shows signalling climbing a few KB, then stopping — and media pinned at 0 B. |
| **Video throughput** | Rolling 60-second chart of actual received bitrate. |
| **Connection path** | `DIRECT · LAN` means host candidates — genuinely peer-to-peer. `RELAYED` would mean traffic through a TURN server, which this prototype does not run. |
| **Phase bar** (top) | signalling → negotiating → connecting → live. |

### Options

| | |
|---|---|
| `PORT=8444 node server.js` | Serve on a different port |
| `node server.js --regen-cert` | Re-mint the certificate after changing networks |
| `node server.js --http` | Plain HTTP; the camera page then only works on `localhost` |

### If the phone will not connect

Almost always one of three things:

| Symptom | Cause | Fix |
|---|---|---|
| Certificate warning names the wrong address, or the page will not load at all | Your laptop's LAN IP changed (new Wi-Fi, DHCP lease) and the certificate still names the old one | `node server.js --regen-cert` |
| Phone cannot reach the address | Phone on mobile data, or on a guest network isolated from the laptop | Same Wi-Fi, guest isolation off |
| Camera page loads but Start does nothing | Opened over `http://` on a LAN address | Use the `https://` address |

To see the address the certificate currently covers:

```bash
openssl x509 -in certs/cert.pem -noout -text | grep -A1 "Subject Alternative Name"
```

### Why HTTPS

Browsers refuse `getUserMedia()` on a plain-HTTP origin unless it is `localhost`.
Reaching the camera page from a phone therefore needs TLS, so the server mints a
self-signed certificate naming every LAN IP it can see. The one-time browser
warning is expected — a real deployment replaces this with a proper certificate.

---

## How it fits together

```
  phone browser                                     laptop browser
  ┌───────────────┐    encrypted video + audio     ┌───────────────┐
  │ camera.html   │ ◄────────────────────────────► │ viewer.html   │
  │               │      DTLS-SRTP, direct         │               │
  │               │ ◄───── data channel ─────────► │               │
  └───────┬───────┘      commands + acks           └───────┬───────┘
          │                                                │
          │  register UID                     resolve UID  │
          │  + heartbeat                      + roster     │
          └────────────────────┐      ┌────────────────────┘
                               ▼      ▼
                        ┌────────────────────┐
                        │     server.js      │
                        │  UID registry +    │
                        │  signalling relay  │
                        │  (no media, ever)  │
                        └────────────────────┘
```

`server.js` has no code path that receives, forwards or stores media. The
`/api/stats` endpoint reports a `mediaBytes` counter that is structurally zero;
the viewer displays it beside the signalling counter so the difference is visible
during a demo.

### Files

| Path | Role |
|---|---|
| `server.js` | UID registry, signalling relay, static files. Zero dependencies |
| `public/camera.html` | The device: publishes video and audio, handles remote commands |
| `public/viewer.html` | The app: watches, talks back, triggers remote capture |
| `public/assets/signal.js` | Signalling transport — SSE down, POST up |
| `public/assets/rtc.js` | Peer configuration, stats reader, on-screen log |
| `public/assets/qr.js` | QR encoder for the join link |
| `tools/qr-selftest.js` | Decodes the encoder's own output and checks RS syndromes |
| `tools/server-selftest.js` | Drives the control plane end to end over real HTTPS |

### Tests

```bash
node tools/qr-selftest.js && node tools/server-selftest.js
```

---

## Native Android app

There is a native Kotlin client in [`../android`](../android/README.md) that
speaks the same protocol — so an Android camera can be watched from this web
viewer, and a web camera can be watched from the Android app.

It is worth running the server in plain HTTP mode when using it:

```bash
node server.js --http
```

A native app has no secure-context rule, so unlike a browser it needs no
certificate at all. That removes the warning screen, which is the most awkward
moment in the browser-only demo.

## Security

A camera is only reachable by someone holding the PIN it displays. See
[SECURITY.md](SECURITY.md) for the full analysis — threat model, the findings
that were fixed (including an unauthenticated remote crash and completely absent
access control), and the residual risks that make this a prototype rather than a
product.

Two things to know before demoing on a network you do not control:

- The TLS certificate is self-signed and unpinned. You are training viewers to
  click through a browser warning.
- The signalling server relays the DTLS fingerprints, so a compromised control
  plane could still sit in the middle of the media. Peer-to-peer alone does not
  prevent that — device key pinning does, which is the section 04 argument.

## What this does not prove

Be straight about this in the client meeting — it is a stronger position than
overclaiming.

- **Both ends are browsers, not camera firmware.** The real device needs the
  signalling client and media pipeline running on the SoC. That is the Phase 1
  work, and it depends on the vendor SDK question.
- **One Wi-Fi network only.** With no STUN or TURN configured, this connects via
  host candidates on the same LAN. Crossing the internet needs the NAT traversal
  tier described in section 02 — including relay for the share of Indian carrier
  connections that will not hole-punch.
- **No pairing security.** Anyone who knows a UID can watch. Real units need the
  per-device key pair burned at flashing, described in section 04.
- **No onboarding flow.** Getting a real camera onto the customer's Wi-Fi (SoftAP
  or QR provisioning) is a separate workstream and the largest single source of
  support tickets in shipped products.
