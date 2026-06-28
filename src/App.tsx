import { useEffect, useRef, useState, type JSX } from "react";
import { DEFAULT_OPTIONS, type AsciiOptions } from "./lib/ascii";
import { THEMES, type Tab, type ThemeName } from "./types";
import CameraTab  from "./components/CameraTab";
import ImageTab   from "./components/ImageTab";
import LibraryTab from "./components/LibraryTab";
import CallTab    from "./components/CallTab";
import AboutTab   from "./components/AboutTab";
import type { LibraryItem } from "./lib/library";

const TAB_ICONS: Record<Tab, JSX.Element> = {
  camera: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  ),
  image: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
    </svg>
  ),
  library: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
    </svg>
  ),
  call: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.46 2 2 0 0 1 3.59 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.13 6.13l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
    </svg>
  ),
  about: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  ),
};

const TABS: { id: Tab; label: string }[] = [
  { id: "camera",  label: "Camera"  },
  { id: "image",   label: "Image"   },
  { id: "library", label: "Library" },
  { id: "call",    label: "Call"    },
  { id: "about",   label: "About"   },
];

export default function App() {
  const [tab,       setTab]       = useState<Tab>("camera");
  const [theme,     setTheme]     = useState<ThemeName>("green");
  const [themeOpen, setThemeOpen] = useState(false);
  const [opts,      setOpts]      = useState<AsciiOptions>({ ...DEFAULT_OPTIONS });
  const [fontSize,  setFontSize]  = useState(10);
  const [exportFg,  setExportFg]  = useState("#39ff14");
  const [libKey,    setLibKey]    = useState(0);
  const [editItem,  setEditItem]  = useState<LibraryItem | null>(null);
  const themeRef    = useRef<HTMLDivElement>(null);
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
              <span className="tab-icon">{TAB_ICONS[t.id]}</span>
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
        {tab === "camera"  && <CameraTab  opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={resetOpts} onLibraryUpdated={() => setLibKey(k => k + 1)} exportFg={exportFg} onExportFgChange={setExportFg} />}
        {tab === "image"   && <ImageTab   opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={resetOpts} onLibraryUpdated={() => setLibKey(k => k + 1)} editItem={editItem} onEditDone={() => setEditItem(null)} exportFg={exportFg} onExportFgChange={setExportFg} />}
        {tab === "library" && <LibraryTab fontSize={fontSize} refreshKey={libKey} onEdit={item => { setEditItem(item); setTab("image"); }} />}
        {tab === "call"    && <CallTab    opts={opts} updateOpt={updateOpt} />}
        {tab === "about"   && <AboutTab />}
      </main>
    </div>
  );
}
