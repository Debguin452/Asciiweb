export interface GlyphFeature {
  char: string;
  codePoint: number;
  density: number;
  edgeH: number;
  edgeV: number;
  edgeDiag1: number;
  edgeDiag2: number;
  contrast: number;
  topHalf: number;
  bottomHalf: number;
  leftHalf: number;
  rightHalf: number;
  corners: number;
  centerWeight: number;
}

export const BLOCK_GLYPHS = " ░▒▓█▄▀▌▐▖▗▘▝▞▟";
export const ASCII_GLYPHS = " `.,:;-+^•=*$#%@";
export const EDGE_GLYPHS = "/\\-_|`";
export const DENSE_GLYPHS = " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@";
export const ALL_GLYPHS = BLOCK_GLYPHS + ASCII_GLYPHS + EDGE_GLYPHS;

const _featureCache = new Map<string, GlyphFeature>();

function sampleGlyph(ch: string, ctx: CanvasRenderingContext2D, W: number, H: number): Float32Array {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "white";
  ctx.fillText(ch, 0, Math.floor(H * 0.85));
  const d = ctx.getImageData(0, 0, W, H).data;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = d[i * 4] / 255;
  return gray;
}

function computeGlyphFeature(ch: string, gray: Float32Array, W: number, H: number): GlyphFeature {
  const N = W * H;
  let density = 0;
  let edgeH = 0, edgeV = 0, edgeDiag1 = 0, edgeDiag2 = 0;
  let topHalf = 0, bottomHalf = 0, leftHalf = 0, rightHalf = 0;
  let corners = 0, centerWeight = 0;
  const hw = W / 2, hh = H / 2;
  const cx = W / 2, cy = H / 2;

  for (let i = 0; i < N; i++) density += gray[i];
  density /= N;

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[(y + 1) * W + x] - gray[(y - 1) * W + x];
      const gd1 = gray[(y + 1) * W + x + 1] - gray[(y - 1) * W + x - 1];
      const gd2 = gray[(y + 1) * W + x - 1] - gray[(y - 1) * W + x + 1];
      edgeH += Math.abs(gx);
      edgeV += Math.abs(gy);
      edgeDiag1 += Math.abs(gd1);
      edgeDiag2 += Math.abs(gd2);
    }
  }
  const edgeN = (W - 2) * (H - 2);
  edgeH /= edgeN; edgeV /= edgeN; edgeDiag1 /= edgeN; edgeDiag2 /= edgeN;

  let localContrast = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = gray[i];
      if (y < hh) topHalf += v; else bottomHalf += v;
      if (x < hw) leftHalf += v; else rightHalf += v;
      const dx = x - cx, dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / Math.max(hw, hh);
      centerWeight += v * Math.max(0, 1 - r);
      const inCorner = (x < W * 0.3 || x > W * 0.7) && (y < H * 0.3 || y > H * 0.7);
      if (inCorner) corners += v;
    }
  }
  const qN = (W * H) / 4;
  topHalf /= qN; bottomHalf /= qN; leftHalf /= qN; rightHalf /= qN;
  corners /= (qN * 0.36);
  centerWeight /= qN;

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      let mn = 1, mx = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++) {
          const v = gray[(y + ky) * W + (x + kx)];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      localContrast += mx - mn;
    }
  }
  localContrast /= edgeN;

  return {
    char: ch, codePoint: ch.codePointAt(0) ?? 0,
    density, edgeH, edgeV, edgeDiag1, edgeDiag2,
    contrast: localContrast,
    topHalf, bottomHalf, leftHalf, rightHalf,
    corners, centerWeight,
  };
}

export function buildGlyphTable(charset: string): GlyphFeature[] {
  const cacheKey = charset;
  const cached: GlyphFeature[] = [];
  const missing: string[] = [];

  for (const ch of Array.from(new Set(Array.from(charset)))) {
    if (_featureCache.has(ch)) {
      cached.push(_featureCache.get(ch)!);
    } else {
      missing.push(ch);
    }
  }
  if (!missing.length) return cached;

  try {
    const W = 12, H = 16;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    ctx.font = `bold ${H * 0.75}px "JetBrains Mono", monospace`;
    ctx.textBaseline = "alphabetic";

    for (const ch of missing) {
      const gray = sampleGlyph(ch, ctx, W, H);
      const feat = computeGlyphFeature(ch, gray, W, H);
      _featureCache.set(ch, feat);
      cached.push(feat);
    }
  } catch {
    for (const ch of missing) {
      const feat: GlyphFeature = {
        char: ch, codePoint: ch.codePointAt(0) ?? 0,
        density: 0, edgeH: 0, edgeV: 0, edgeDiag1: 0, edgeDiag2: 0,
        contrast: 0, topHalf: 0, bottomHalf: 0, leftHalf: 0, rightHalf: 0,
        corners: 0, centerWeight: 0,
      };
      _featureCache.set(ch, feat);
      cached.push(feat);
    }
  }
  return cached;
}

export interface CellContext {
  luminance: number;
  edgeMag: number;
  edgeDir: number;
  localContrast: number;
  topHalf: number;
  bottomHalf: number;
  leftHalf: number;
  rightHalf: number;
  textureVar: number;
}

export function selectGlyph(ctx: CellContext, glyphs: GlyphFeature[]): GlyphFeature {
  const lum = ctx.luminance / 255;
  const edgeMag = Math.min(ctx.edgeMag / 255, 1);
  const contrast = Math.min(ctx.localContrast / 255, 1);
  const edgeDir = ctx.edgeDir;

  if (edgeMag > 0.3 && glyphs.some(g => EDGE_GLYPHS.includes(g.char))) {
    const deg = ((edgeDir * 180 / Math.PI) + 360) % 180;
    const edgeChar = deg < 22.5 || deg >= 157.5 ? "-"
      : deg < 67.5 ? "/"
      : deg < 112.5 ? "|"
      : "\\";
    const eg = glyphs.find(g => g.char === edgeChar);
    if (eg) return eg;
  }

  let best = glyphs[0];
  let bestScore = -Infinity;

  for (const g of glyphs) {
    const lumSim = 1 - Math.abs(lum - g.density);
    const edgeSim = 1 - Math.abs(edgeMag - Math.max(g.edgeH, g.edgeV));
    const contrastSim = 1 - Math.abs(contrast - g.contrast);
    const topBottomSim = 1 - Math.abs((ctx.topHalf - ctx.bottomHalf) / 255 - (g.topHalf - g.bottomHalf));
    const leftRightSim = 1 - Math.abs((ctx.leftHalf - ctx.rightHalf) / 255 - (g.leftHalf - g.rightHalf));
    const textureSim = 1 - Math.abs(ctx.textureVar / 255 - g.contrast);

    const score =
      0.35 * lumSim +
      0.25 * edgeSim +
      0.15 * contrastSim +
      0.125 * (topBottomSim + leftRightSim) / 2 +
      0.125 * textureSim;

    if (score > bestScore) { bestScore = score; best = g; }
  }
  return best;
}
