import { useState } from "react";
import { DEFAULT_CHARSET, type AsciiOptions } from "../lib/ascii";
import { PRESETS, CHARSET_PRESETS, FONT_SIZES, type PresetName } from "../types";

interface ControlsPanelProps {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
}

const SECTIONS = ["Presets", "Display", "Image", "Mode", "Charset", "Advanced"] as const;
type Section = typeof SECTIONS[number];

export default function ControlsPanel({ opts, updateOpt, fontSize, setFontSize, onReset }: ControlsPanelProps) {
  const [section, setSection] = useState<Section>("Presets");

  const applyPreset = (name: PresetName) => {
    const p = PRESETS[name] as Record<string, unknown>;
    for (const [k, v] of Object.entries(p)) {
      updateOpt(k as keyof AsciiOptions, v as never);
    }
  };

  const si = SECTIONS.indexOf(section);
  const prev = () => setSection(SECTIONS[Math.max(0, si - 1)]);
  const next = () => setSection(SECTIONS[Math.min(SECTIONS.length - 1, si + 1)]);

  return (
    <aside className="controls-panel">
      <div className="section-nav">
        <button className="btn btn-ghost btn-xs" onClick={prev} disabled={si === 0}>◀</button>
        <span className="section-title">{section}</span>
        <button className="btn btn-ghost btn-xs" onClick={next} disabled={si === SECTIONS.length - 1}>▶</button>
        <div className="section-dots">
          {SECTIONS.map((s, i) => (
            <button key={s} className={`dot-btn ${s === section ? "dot-active" : ""}`} onClick={() => setSection(s)} />
          ))}
        </div>
      </div>

      <div className="panel-body">
        {section === "Presets" && (
          <div className="panel-section">
            <div className="preset-grid">
              {(Object.keys(PRESETS) as PresetName[]).map(name => (
                <button key={name} className="btn btn-preset" onClick={() => applyPreset(name)}>
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        {section === "Display" && (
          <div className="panel-section">
            <label className="section-label">Font Size</label>
            <div className="btn-group-wrap">
              {FONT_SIZES.map(s => (
                <button key={s} className={`btn btn-sm ${fontSize === s ? "btn-active" : "btn-ghost"}`} onClick={() => setFontSize(s)}>{s}</button>
              ))}
            </div>
            <div className="vgap" />
            <SliderRow label="Columns" value={opts.asciiW} min={20} max={220} step={2} onChange={v => updateOpt("asciiW", v)} />
            <SliderRow label="Rows" value={opts.asciiH} min={10} max={100} step={1} onChange={v => updateOpt("asciiH", v)} />
          </div>
        )}

        {section === "Image" && (
          <div className="panel-section">
            <SliderRow label="Brightness" value={opts.brightness} min={-128} max={128} step={1} showSign onChange={v => updateOpt("brightness", v)} />
            <SliderRow label="Contrast" value={opts.contrast} min={10} max={300} step={5} unit="%" onChange={v => updateOpt("contrast", v)} />
            <SliderRow label="Gamma" value={opts.gamma} min={0.5} max={2.5} step={0.1} isFloat onChange={v => updateOpt("gamma", v)} />
            <SliderRow label="Threshold (0=off)" value={opts.threshold} min={0} max={254} step={1} onChange={v => updateOpt("threshold", v)} />
          </div>
        )}

        {section === "Mode" && (
          <div className="panel-section">
            <div className="toggle-grid">
              <Toggle label="Color"       value={opts.color}            onChange={v => updateOpt("color", v)} />
              <Toggle label="Edges"       value={opts.edges}            onChange={v => updateOpt("edges", v)} />
              <Toggle label="Directions"  value={opts.gradientDirs}     onChange={v => updateOpt("gradientDirs", v)} />
              <Toggle label="Dither"      value={opts.dither}           onChange={v => updateOpt("dither", v)} />
              <Toggle label="Invert"      value={opts.invert}           onChange={v => updateOpt("invert", v)} />
              <Toggle label="Braille"     value={opts.brailleMode}      onChange={v => updateOpt("brailleMode", v)} />
              <Toggle label="Blocks"      value={opts.blockMode}        onChange={v => updateOpt("blockMode", v)} />
              <Toggle label="Temporal"    value={opts.temporalSmoothing} onChange={v => updateOpt("temporalSmoothing", v)} />
            </div>
            {opts.dither && (
              <>
                <div className="vgap" />
                <label className="section-label">Dither Mode</label>
                <div className="btn-group-wrap">
                  {(["floyd", "bayer"] as const).map(m => (
                    <button key={m} className={`btn btn-sm ${opts.ditherMode === m ? "btn-active" : "btn-ghost"}`} onClick={() => updateOpt("ditherMode", m)}>{m}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {section === "Charset" && (
          <div className="panel-section">
            <label className="section-label">Character Set</label>
            <input
              className="charset-input"
              value={opts.charset}
              onChange={e => updateOpt("charset", e.target.value || DEFAULT_CHARSET)}
              spellCheck={false}
            />
            <label className="section-label" style={{ marginTop: "8px" }}>Presets</label>
            <div className="charset-presets">
              {CHARSET_PRESETS.map(([name, set]) => (
                <button key={name} className="btn btn-xs btn-ghost" onClick={() => updateOpt("charset", set)}>{name}</button>
              ))}
            </div>
            <div className="vgap" />
            <Toggle label="Auto-sort by density" value={opts.charDensitySort} onChange={v => updateOpt("charDensitySort", v)} />
          </div>
        )}

        {section === "Advanced" && (
          <div className="panel-section">
            <div className="toggle-grid">
              <Toggle label="Noise Reduction"  value={opts.noiseReduction} onChange={v => updateOpt("noiseReduction", v)} />
              <Toggle label="Local Contrast"   value={opts.localContrast}  onChange={v => updateOpt("localContrast", v)} />
              <Toggle label="Histogram Eq."    value={opts.histEq}         onChange={v => updateOpt("histEq", v)} />
            </div>
            <div className="vgap" />
            <button className="btn btn-ghost btn-full" onClick={onReset}>Reset all defaults</button>
          </div>
        )}
      </div>
    </aside>
  );
}

function SliderRow({ label, value, min, max, step, onChange, unit = "", showSign = false, isFloat = false }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; unit?: string; showSign?: boolean; isFloat?: boolean;
}) {
  const display = isFloat ? value.toFixed(1) : (showSign && value > 0 ? `+${value}` : `${value}`);
  return (
    <div className="slider-row">
      <div className="slider-header">
        <span>{label}</span>
        <span className="slider-value">{display}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} className="slider" />
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle-btn ${value ? "toggle-on" : ""}`} onClick={() => onChange(!value)}>
      <span className="toggle-indicator">{value ? "●" : "○"}</span>
      {label}
    </button>
  );
}
