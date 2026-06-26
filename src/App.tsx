import { useEffect, useRef, useState } from "react";
import { DEFAULT_OPTIONS, type AsciiOptions } from "./lib/ascii";
import { THEMES, type Tab, type ThemeName } from "./types";
import CameraTab  from "./components/CameraTab";
import ImageTab   from "./components/ImageTab";
import LibraryTab from "./components/LibraryTab";
import CallTab    from "./components/CallTab";
import AboutTab   from "./components/AboutTab";
import type { LibraryItem } from "./lib/library";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "camera",  label: "Camera",  icon: "📷" },
  { id: "image",   label: "Image",   icon: "🖼" },
  { id: "library", label: "Library", icon: "🗂" },
  { id: "call",    label: "Call",    icon: "📡" },
  { id: "about",   label: "About",   icon: "ℹ" },
];

export default function App() {
  const [tab,        setTab]        = useState<Tab>("camera");
  const [theme,      setTheme]      = useState<ThemeName>("green");
  const [themeOpen,  setThemeOpen]  = useState(false);
  const [opts,       setOpts]       = useState<AsciiOptions>({ ...DEFAULT_OPTIONS });
  const [fontSize,   setFontSize]   = useState(10);
  const [exportFg,   setExportFg]   = useState("#39ff14");
  const [libKey,     setLibKey]     = useState(0);
  const [editItem,   setEditItem]   = useState<LibraryItem | null>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const prevIsLight = useRef(false);

  const updateOpt = <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) =>
    setOpts(o => ({ ...o, [key]: val }));
  const resetOpts = () => setOpts({ ...DEFAULT_OPTIONS });

  const changeTheme = (t: ThemeName) => {
    const nextLight = THEMES.find(th => th.id === t)?.light ?? false;
    if (nextLight !== prevIsLight.current) {
      setOpts(o => ({ ...o, invert: nextLight }));
      prevIsLight.current = nextLight;
    }
    setTheme(t); setThemeOpen(false);
  };

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) setThemeOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const isLight = THEMES.find(t => t.id === theme)?.light ?? false;

  return (
    <div className={`app-root${isLight ? " app-light" : ""}`} data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-prompt">$</span>
          <span className="brand-name">asciiweb</span>
          <span className="brand-cursor">_</span>
        </div>

        <nav className="tab-bar">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`tab-btn${tab === t.id ? " tab-active" : ""}`}
              onClick={() => setTab(t.id)}
              title={t.label}
            >
              <span className="tab-icon">{t.icon}</span>
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="theme-picker" ref={themeRef}>
          <button className="theme-trigger" onClick={() => setThemeOpen(o => !o)} title="Theme">
            <span className={`theme-dot-preview theme-dot-${theme}`} />
          </button>
          {themeOpen && (
            <div className="theme-dropdown">
              {THEMES.map(t => (
                <button
                  key={t.id}
                  className={`theme-option${theme === t.id ? " theme-option-active" : ""}`}
                  onClick={() => changeTheme(t.id)}
                >
                  <span className={`theme-dot-preview theme-dot-${t.id}`} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <main className="app-main">
        {tab === "camera"  && <CameraTab  opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={resetOpts} onLibraryUpdated={() => setLibKey(k => k+1)} exportFg={exportFg} onExportFgChange={setExportFg} />}
        {tab === "image"   && <ImageTab   opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={resetOpts} onLibraryUpdated={() => setLibKey(k => k+1)} editItem={editItem} onEditDone={() => setEditItem(null)} exportFg={exportFg} onExportFgChange={setExportFg} />}
        {tab === "library" && <LibraryTab fontSize={fontSize} refreshKey={libKey} onEdit={item => { setEditItem(item); setTab("image"); }} />}
        {tab === "call"    && <CallTab opts={opts} updateOpt={updateOpt} />}
        {tab === "about"   && <AboutTab />}
      </main>
    </div>
  );
}
