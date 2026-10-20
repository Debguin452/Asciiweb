# asciiweb

Turn your camera, your images and your video calls into ASCII art — right in the browser.
No account, no install, no server-side processing. Installable as a PWA and works offline (except calls).

```
$ asciiweb_
```

## Features

| Tab | URL | What it does |
|-----|-----|--------------|
| **Camera** | `/camera` | Live webcam → ASCII at up to 60 fps. HQ / Balanced / High-Speed quality modes, front/back camera, copy as text, capture a frame, record clips. |
| **Image** | `/image` | Drop in a picture, crop it, tune it and export. |
| **Library** | `/library` | Everything you saved, stored locally in your browser (IndexedDB). Play back recordings, re-open items in the Image editor. |
| **Call** | `/call` · `/call/CODE` | Peer-to-peer ASCII video calls with audio. Share a room as a link. |
| **About** | `/about` | Credits and how it works. |

### Rendering controls

- **Presets:** Classic, Dense, Blocks, Edges, Sketch, Dither, Color, Braille, Enhanced.
- **Image tuning:** brightness, contrast, gamma, threshold, noise reduction, local contrast, histogram equalisation.
- **Detail:** edge detection (Sobel), Floyd–Steinberg and Bayer dithering, Braille and block glyph modes, custom charsets, invert.
- **Themes:** Green, Amber, Cyan, Mono, Green Light.
- **Heavy lifting in WebAssembly** (Rust, see [`wasm-module/`](wasm-module/README.md)) with a pure-JS fallback.

### Export

Plain text · PNG · JPEG · animated GIF · MP4 · **ATV** (a compact custom ASCII-video format with motion prediction, palette + Huffman coding — see `src/lib/atv/`).

## Video calls

Open **Call**, press **Start a call** and send the link (**Share link** / **Copy link**) or the 6-character code.
Whoever opens `https://<your-site>/call/ABC123` lands on the Call tab with the code pre-filled — one tap on **Join**.

- **Four display modes** (drop-down in the call bar):
  - **ASCII** – plain characters.
  - **Color** – smooth colour video (default).
  - **Pixel** – solid `█` cells, the same look as the Camera tab's pixel view.
  - **Color ASCII** – characters tinted with the camera's colours.
- **Calls keep running when you switch tabs.** A red dot appears on the Call tab and a "Call in progress" pill lets you jump back.
- Ending a call takes **two taps** on the red button, so a stray touch can't hang up on someone.
- Adapts to your connection: resolution and frame rate scale down automatically when the link is poor.

### How a call works

1. **Signalling:** a tiny Cloudflare Pages Function (`functions/api/rooms*`) stores `room code → peer IDs` in Workers KV (4 h TTL). Nothing else touches the server.
2. **Transport:** [PeerJS](https://peerjs.com) / WebRTC. Audio goes over a media stream; video goes over a data channel as compact binary frames. STUN/TURN fallbacks are configured in `src/lib/call.ts`.
3. **Wire format** (`src/lib/binary.ts`): bit-packed glyph indices and/or an adaptive 256-colour palette, with varint gap-coded delta frames, periodic keyframes, and an automatic keyframe whenever the display mode changes.
4. **Rendering:** the receiver paints whatever the frame carries — ASCII text, coloured `<span>` runs, or a canvas — so the two sides can use different modes.

## URLs

Client-side routing with no dependency (`src/App.tsx`):

```
/camera   /image   /library   /call   /about
/call/ABC123     invite link → Call tab, code pre-filled
/join/ABC123     alias of the above
```

`public/_redirects` (`/*  /index.html  200`) makes Cloudflare Pages serve the app for these paths, so refreshing or sharing a deep link works.

## Getting started

Requires **Node 20** (see `.nvmrc`).

```bash
npm ci
npm run dev        # http://localhost:5173
npm run typecheck
npm run build      # outputs to dist/
npm run preview
```

Camera access needs a secure context: `localhost` or HTTPS.

### Deploy to Cloudflare Pages

1. Create a Pages project from this repo — build command `npm run build`, output directory `dist`.
2. Create a KV namespace and bind it as **`ROOMS_KV`** (see `wrangler.toml`). It's only needed for call rooms; everything else works without it.
3. That's it — `functions/` is picked up automatically.

### Rebuilding the WASM module (optional)

The compiled module is committed in `src/lib/wasm-pkg/`. To rebuild after editing the Rust source:

```bash
cd wasm-module
./build-wasm.sh
```

A GitHub Action (`.github/workflows/build-wasm.yml`) also rebuilds it when `wasm-module/**` changes.

## Project layout

```
src/
  App.tsx                 shell, tab router, theme, "call in progress" pill
  components/             CameraTab, ImageTab, LibraryTab, CallTab, AboutTab, ControlsPanel, Modal, Player
  lib/
    ascii.ts              frame → ASCII conversion (WASM + JS paths)
    binary.ts             call wire format, palette quantiser
    call.ts               CallManager (PeerJS, quality adaptation, keyframes)
    export.ts             text / PNG / JPEG / GIF / MP4 / ATV export
    library.ts            IndexedDB storage
    atv/                  ATV video codec
    wasm-pkg/             compiled WebAssembly
functions/api/            Cloudflare Pages Functions (call rooms)
wasm-module/              Rust source for the WASM module
public/                   manifest, service worker, _headers, _redirects
```

## Accessibility & feel

Visible keyboard focus rings, `aria` labels on call state, reduced-motion support (all animation is disabled when the OS asks for it), subtle press/hover feedback on every control, and a light haptic tick on touch devices.

## Privacy

Camera frames are processed locally. In a call, video and audio travel directly between the two browsers (WebRTC); the server only brokers the room code. The Library never leaves your device.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) © Deb Guin.
