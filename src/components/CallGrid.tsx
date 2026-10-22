import { useEffect, useRef, useState, type ReactNode } from "react";

export interface GridTile {
  /** "self" for the local camera tile, otherwise the remote peer's id. */
  id: string;
  isSelf: boolean;
  /** Caller-provided content (the <pre>/<canvas> for that participant) — CallGrid only handles layout, not rendering. */
  content: ReactNode;
  muted?: boolean;
  camOff?: boolean;
}

interface Props {
  tiles: GridTile[]; // includes the self tile; order = join order (self may be anywhere, layout re-sorts as needed)
  className?: string;
}

type Mode = "pip" | "focused" | "grid";

interface Layout {
  big: GridTile | null;
  strip: GridTile[];
  mode: Mode;
}

/**
 * Pure layout rule, independent of rendering, so it's unit-testable without a DOM:
 *   - 2 participants: picture-in-picture — one tile fills the area, the other is a small
 *     corner overlay. Defaults to the other person big, self small; tapping either tile swaps
 *     which one is big (this is also how "zoom to your own camera" works — it's the same tap).
 *   - 3 participants: one big tile + the other two as a small side-by-side strip. Defaults to
 *     the first-joined other participant big, self defaults into the strip.
 *   - 4 participants (the cap): an equal 2x2 grid, nobody focused by default.
 *   - Tapping any tile in the 3- or 4-person layouts promotes it to big with everyone else as
 *     the strip; tapping the current big tile again clears the focus and returns to the default
 *     for that participant count.
 */
export function computeLayout(tiles: GridTile[], focusedId: string | null): Layout {
  const n = tiles.length;
  if (n <= 1) return { big: tiles[0] ?? null, strip: [], mode: "grid" };

  if (n === 2) {
    const self  = tiles.find(t => t.isSelf) ?? tiles[0];
    const other = tiles.find(t => !t.isSelf) ?? tiles[1];
    const big   = focusedId === self.id ? self : other;
    const small = big.id === self.id ? other : self;
    return { big, strip: [small], mode: "pip" };
  }

  if (focusedId) {
    const big = tiles.find(t => t.id === focusedId);
    if (big) return { big, strip: tiles.filter(t => t.id !== focusedId), mode: "focused" };
  }

  if (n === 3) {
    // Others (join order) first, self last — the default focus favors seeing
    // other people over your own camera.
    const others = tiles.filter(t => !t.isSelf);
    const self   = tiles.filter(t => t.isSelf);
    const ordered = [...others, ...self];
    const [big, ...strip] = ordered;
    return { big, strip, mode: "focused" };
  }

  // 4 participants (the cap), unfocused: equal grid, nobody singled out.
  return { big: null, strip: tiles, mode: "grid" };
}

function Tile({ tile, onTap, large }: { tile: GridTile; onTap: () => void; large: boolean }) {
  return (
    <div
      className={`call-grid-tile${large ? " call-grid-tile-large" : ""}${tile.isSelf ? " call-grid-tile-self" : ""}`}
      onClick={onTap}
      role="button"
      tabIndex={0}
    >
      {tile.content}
      {(tile.muted || tile.camOff) && (
        <span className="call-grid-badges">
          {tile.muted  && <span title="Muted" className="call-grid-badge">mic off</span>}
          {tile.camOff && <span title="Camera off" className="call-grid-badge">cam off</span>}
        </span>
      )}
    </div>
  );
}

export default function CallGrid({ tiles, className }: Props) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pipPos, setPipPos] = useState({ right: 12, bottom: 68 });
  const pipDragRef = useRef<{ startX: number; startY: number; origRight: number; origBottom: number; moved: boolean } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pipRef = useRef<HTMLDivElement>(null);

  // If the focused participant leaves the call, fall back to the default
  // layout for however many people remain, rather than focusing on a tile
  // that no longer exists (or silently focusing nothing visible).
  useEffect(() => {
    if (focusedId && !tiles.some(t => t.id === focusedId)) setFocusedId(null);
  }, [tiles, focusedId]);

  const { big, strip, mode } = computeLayout(tiles, focusedId);

  const onTileTap = (id: string) => {
    setFocusedId(current => (current === id ? null : id));
  };

  const onPipPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    pipDragRef.current = { startX: e.clientX, startY: e.clientY, origRight: pipPos.right, origBottom: pipPos.bottom, moved: false };
  };
  const onPipPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = pipDragRef.current; if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
    const container = containerRef.current, pip = pipRef.current;
    if (!container || !pip) return;
    const cw = container.clientWidth, ch = container.clientHeight;
    const pw = pip.offsetWidth, ph = pip.offsetHeight;
    setPipPos({
      right:  Math.max(0, Math.min(cw - pw, d.origRight  - dx)),
      bottom: Math.max(0, Math.min(ch - ph, d.origBottom - dy)),
    });
  };
  const onPipPointerUp = (id: string) => {
    const wasDrag = pipDragRef.current?.moved;
    pipDragRef.current = null;
    if (!wasDrag) onTileTap(id); // a drag shouldn't also count as a tap-to-swap
  };

  if (!big && strip.length === 0) return null;

  return (
    <div ref={containerRef} className={`call-grid call-grid-${mode}${className ? " " + className : ""}`}>
      {mode === "pip" && big && (
        <>
          <Tile tile={big} large onTap={() => onTileTap(big.id)} />
          {strip[0] && (
            <div
              ref={pipRef}
              className="call-grid-pip-small"
              style={{ right: pipPos.right, bottom: pipPos.bottom }}
              onPointerDown={onPipPointerDown}
              onPointerMove={onPipPointerMove}
              onPointerUp={() => onPipPointerUp(strip[0].id)}
              onPointerCancel={() => { pipDragRef.current = null; }}
            >
              <Tile tile={strip[0]} large={false} onTap={() => { /* handled via pointerup above, to distinguish drag from tap */ }} />
            </div>
          )}
        </>
      )}

      {mode === "focused" && big && (
        <>
          <div className="call-grid-big-area">
            <Tile tile={big} large onTap={() => onTileTap(big.id)} />
          </div>
          <div className="call-grid-strip">
            {strip.map(t => <Tile key={t.id} tile={t} large={false} onTap={() => onTileTap(t.id)} />)}
          </div>
        </>
      )}

      {mode === "grid" && (
        <div className={`call-grid-equal call-grid-equal-${strip.length}`}>
          {strip.map(t => <Tile key={t.id} tile={t} large={false} onTap={() => onTileTap(t.id)} />)}
        </div>
      )}
    </div>
  );
}
