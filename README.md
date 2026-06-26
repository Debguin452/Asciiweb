# AsciiCam

Live webcam and images converted to ASCII art — entirely in your browser. Works offline after first load.

Made by [Deb Guin](https://github.com/Debguin452/Asciicam)

---

## Rendering Pipeline

```
Video / Image
      │
      ▼
Resize to asciiW × asciiH
(offscreen canvas, hardware-accelerated)
      │
      ▼
Extract RGBA pixels
      │
      ▼
RGB → Luminance
  lum = 0.299·R + 0.587·G + 0.114·B
      │
      ▼
Gamma correction   (optional)
  lum = (lum/255)^(1/γ) × 255
      │
      ▼
Contrast           (optional)
  lum = 128 + (lum - 128) × contrast/100
      │
      ▼
Brightness offset  (optional)
  lum = lum + brightness
      │
      ├──────────────────────────────────┐
      │ (optional: noise reduction)      │
      │ 3×3 Gaussian blur               │
      │                                  │
      ▼                                  ▼
Histogram Equalization       Local Contrast Enhancement
(expand dynamic range)       lum += (lum - blurred) × 1.5
      │                                  │
      └──────────────┬───────────────────┘
                     │
                     ▼
           Temporal Smoothing         (optional, camera only)
           lum = prev×0.6 + curr×0.4
           (reduces flicker between frames)
                     │
                     ├──────────────────────────────────────┐
                     │                                      │
                     ▼ (edge modes)                         ▼ (normal)
              Sobel Gradient                          pass-through
              Gx = [-1  0  1]
                   [-2  0  2]
                   [-1  0  1]
              Gy = [-1 -2 -1]
                   [ 0  0  0]
                   [ 1  2  1]
              mag = |Gx| + |Gy|
              dir = atan2(Gy, Gx)
                     │
                     ├─── Gradient Direction Mode ─────────────┐
                     │    dir < 22.5°  or ≥ 157.5°  →  -      │
                     │    22.5° – 67.5°              →  /      │
                     │    67.5° – 112.5°             →  |      │
                     │    112.5° – 157.5°            →  \      │
                     │                                         │
                     ▼                                         │
              Floyd-Steinberg Dither      (optional)           │
              error diffused to →, ↙, ↓, ↘ neighbors          │
              — or —                                           │
              Bayer 4×4 Ordered Dither   (optional)            │
              stable pattern, no temporal crawl                │
                     │                                         │
                     └────────────────┬────────────────────────┘
                                      │
                                      ▼
                          Threshold / Binary Mode   (optional, 0 = off)
                          lum < threshold → darkest char
                          lum ≥ threshold → lightest char
                                      │
                                      ▼
                          Luminance → Character Index
                          idx = lum/255 × (nChars - 1)
                          (inverted if invert mode on)
                                      │
                          ┌───────────┴───────────┐
                          │                       │
                          ▼                       ▼
                     Normal mode            Braille mode
                     chars[idx]             4×2 dot grid
                     from sorted            → Unicode U+2800
                     charset                  braille block
                          │                       │
                          └───────────┬───────────┘
                                      │
                                      ▼
                               ASCII Frame
                          ┌─────────────────────┐
                          │  AsciiCell[][]       │
                          │  { char, charIdx,    │
                          │    r, g, b }         │
                          └─────────────────────┘
                                      │
                          ┌───────────┴───────────┐
                          │                       │
                          ▼                       ▼
                    HTML Output             Text Output
                    (color spans)           (plain chars)
                    innerHTML               innerText / .txt
                                                  │
                                            ┌─────┴──────────┐
                                            │                │
                                            ▼                ▼
.mp4 or .gif export     .txt export
                                     (comming soon!)      (plain text,
                    human-readable,

                     importable)
```

---

## Features

- **Camera** — live ASCII rendering via Web Worker (off main thread), Temporal Smoothing, auto-saves recordings to Library
- **Image** — drag-and-drop or upload, real-time re-render as you adjust controls, color preserved
- **Library** — IndexedDB-backed local library; import `.txt`, `.png`, `.jpg`, `.webp`; play/pause/scrub video items.
- **Formats** — `.txt`, [`.mp4` and `.gif` coming soon!]
- **Rendering modes** — Classic, Dense, Blocks, Edges, Edge Lines, Sketch, Dither (Floyd-Steinberg or Bayer), Color, Braille, High Contrast, Enhanced
- **Adjustments** — Brightness, Contrast, Gamma, Threshold, Invert, Noise Reduction, Local Contrast, Histogram Equalisation

---

## Local development

```bash
npm install
npm run dev
```

---

## Credits & License

Copyright (c) 2026 Deb Guin (https://github.com/Debguin452/Asciicam)

Inspired by [AsciiCam](https://github.com/Harshit-Dhanwalkar/AsciiCam) by Harshit Dhanwalkar.

Licensed under the **PolyForm Noncommercial License 1.0.0** — see [LICENSE.md](./LICENSE.md).
Free for personal, educational, and noncommercial use. **Commercial use is not permitted**.
