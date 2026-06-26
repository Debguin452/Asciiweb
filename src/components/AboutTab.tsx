export default function AboutTab() {
  return (
    <div className="tab-content">
      <div className="about-scroll">
        <div className="about-panel">
          <section className="about-section">
            <h2 className="about-heading">Keyboard Shortcuts</h2>
            <table className="shortcuts-table">
              <tbody>
                <tr><td className="shortcut-key">Space</td><td className="shortcut-desc">Start / stop camera</td></tr>
                <tr><td className="shortcut-key">R</td><td className="shortcut-desc">Start / stop recording</td></tr>
                <tr><td className="shortcut-key">C</td><td className="shortcut-desc">Capture current frame</td></tr>
                <tr><td className="shortcut-key">Esc</td><td className="shortcut-desc">Close controls panel</td></tr>
                <tr><td className="shortcut-key">⌘S</td><td className="shortcut-desc">Save as TXT (Image tab)</td></tr>
                <tr><td className="shortcut-key">← →</td><td className="shortcut-desc">Swipe controls sections (touch)</td></tr>
              </tbody>
            </table>
          </section>

          <section className="about-section">
            <h2 className="about-heading">asciiweb</h2>
            <p className="about-text">
              Live webcam and images converted to ASCII art — entirely in your browser.
              Works offline after first load.
            </p>
          </section>

          <section className="about-section">
            <h2 className="about-heading">Rendering Modes</h2>
            <table className="shortcuts-table">
              <tbody>
                <tr><td className="shortcut-key">Classic</td><td className="shortcut-desc">Luminance mapped to character density</td></tr>
                <tr><td className="shortcut-key">Color</td><td className="shortcut-desc">Full color with per-character RGB spans</td></tr>
                <tr><td className="shortcut-key">Braille</td><td className="shortcut-desc">Unicode braille blocks, 2×4 dot grid per cell</td></tr>
                <tr><td className="shortcut-key">Edges</td><td className="shortcut-desc">Sobel gradient edge detection</td></tr>
                <tr><td className="shortcut-key">Edge Lines</td><td className="shortcut-desc">Directional edge chars — | / \ —</td></tr>
                <tr><td className="shortcut-key">Sketch</td><td className="shortcut-desc">Inverted edge lines, pencil-sketch look</td></tr>
                <tr><td className="shortcut-key">Dither</td><td className="shortcut-desc">Floyd-Steinberg error diffusion</td></tr>
                <tr><td className="shortcut-key">Bayer Dither</td><td className="shortcut-desc">Ordered 4×4 bayer matrix dither</td></tr>
                <tr><td className="shortcut-key">Blocks</td><td className="shortcut-desc">Unicode block elements ░▒▓█</td></tr>
                <tr><td className="shortcut-key">High Contrast</td><td className="shortcut-desc">Hard threshold, minimal charset</td></tr>
                <tr><td className="shortcut-key">Enhanced</td><td className="shortcut-desc">Noise reduction + local contrast + histogram eq</td></tr>
              </tbody>
            </table>
          </section>

          <section className="about-section">
            <h2 className="about-heading">Export Formats</h2>
            <table className="shortcuts-table">
              <tbody>
                <tr><td className="shortcut-key">TXT</td><td className="shortcut-desc">Plain text ASCII art</td></tr>
                <tr><td className="shortcut-key">PNG</td><td className="shortcut-desc">Rendered image, lossless</td></tr>
                <tr><td className="shortcut-key">JPG</td><td className="shortcut-desc">Rendered image, compressed</td></tr>
                <tr><td className="shortcut-key">GIF</td><td className="shortcut-desc">Animated, client-side encoded</td></tr>
                <tr><td className="shortcut-key">MP4</td><td className="shortcut-desc">Video via WebCodecs / MediaRecorder fallback</td></tr>
              </tbody>
            </table>
          </section>

          <section className="about-section">
            <h2 className="about-heading">License</h2>
            <p className="about-text">
              Copyright © 2026 Deb Guin. PolyForm Noncommercial License 1.0.0.
              Free for personal, educational, and noncommercial use.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
