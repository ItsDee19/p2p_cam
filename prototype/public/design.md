---
version: "1.0"
name: "AVLYS — mobile camera system"
description: "GRAVITY-informed product UI for iOS and Android. Paper specimen outside the device; warm-black instrument inside the phone."
colors:
  paper: "#EFEBE3"
  paper-2: "#EAE5DB"
  ink: "#191713"
  muted: "#6b665c"
  stone: "#a39d8f"
  device-ground: "#0B0C0A"
  device-surface: "#141210"
  live: "#C4452D"
  link: "#C4A574"
typography:
  display: system-ui
  mono: "Courier New"
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  device: 36px
spacing:
  sm: 1rem
  md: 2rem
  lg: 4rem
---

# AVLYS · Mobile design system

Not less AI. This is the manufacturer-facing product UI: the app a customer opens on iPhone or Android to pair a Wi-Fi camera and watch it.

## Brand

- **Name:** AVLYS
- **Voice:** short, physical, no cloud poetry
- **Mark:** wordmark only, tracked uppercase, no icon-as-logo
- **Inside the phone:** warm black, one live colour (brick red), one metal colour (GRAVITY gold) for pairing/control
- **Outside the phone (this tab):** GRAVITY paper specimen

## Screens in the system

| ID | Screen | Role |
|---|---|---|
| splash | Launch | Brand, 1.2s |
| home | Choose | Be the camera / Watch a camera |
| pair | Add camera | UID + 6-digit PIN |
| connecting | Handshake | Signalling → ICE → live |
| live | Single cam | Feed, talk, listen, capture |
| grid | Multi-cam | 2×2 operations |
| settings | Device | PIN rotate, unpair, storage |
| device | Camera unit | This phone publishes; PIN on screen |

## Rules

- Zero neon. No glassmorphism. No Inter.
- Live is red. Pairing/control is gold. Offline is ink on paper stripe.
- PIN is the largest number on the camera device screen.
- Media never labelled as “cloud”. Path reads **P2P DIRECT**.
