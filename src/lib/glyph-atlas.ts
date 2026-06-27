export interface GlyphAtlas {
  canvas: HTMLCanvasElement;
  charMap: Map<string, { x: number; y: number; w: number; h: number }>;
  cellWidth: number;
  cellHeight: number;
  fontSize: number;
  fontFamily: string;
}

export function createGlyphAtlas(
  charset: string,
  fontSize: number = 14,
  fontFamily: string = 'monospace',
  columns: number = 16
): GlyphAtlas {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  ctx.font = `${fontSize}px ${fontFamily}`;
  const metrics = ctx.measureText('M');
  const cellWidth = Math.ceil(metrics.width);
  const cellHeight = Math.ceil(fontSize * 1.2);

  const rows = Math.ceil(charset.length / columns);
  canvas.width = cellWidth * columns;
  canvas.height = cellHeight * rows;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';

  const charMap = new Map<string, { x: number; y: number; w: number; h: number }>();

  for (let i = 0; i < charset.length; i++) {
    const char = charset[i];
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = col * cellWidth;
    const y = row * cellHeight;

    ctx.fillText(char, x, y);

    charMap.set(char, { x, y, w: cellWidth, h: cellHeight });
  }

  return {
    canvas,
    charMap,
    cellWidth,
    cellHeight,
    fontSize,
    fontFamily
  };
}

export class AtlasRenderer {
  private atlas: GlyphAtlas;
  private targetCanvas: HTMLCanvasElement;
  private targetCtx: CanvasRenderingContext2D;
  private prevFrame: string[] | null = null;

  constructor(atlas: GlyphAtlas, targetCanvas: HTMLCanvasElement) {
    this.atlas = atlas;
    this.targetCanvas = targetCanvas;
    this.targetCtx = targetCanvas.getContext('2d')!;
  }

  render(frame: string[][], colors?: Uint8Array | null): void {
    const rows = frame.length;
    const cols = frame[0]?.length || 0;

    const targetW = cols * this.atlas.cellWidth;
    const targetH = rows * this.atlas.cellHeight;

    if (this.targetCanvas.width !== targetW) this.targetCanvas.width = targetW;
    if (this.targetCanvas.height !== targetH) this.targetCanvas.height = targetH;

    const ctx = this.targetCtx;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, targetW, targetH);

    const flatFrame: string[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        flatFrame.push(frame[y][x]);
      }
    }

    let changedCount = 0;

    for (let i = 0; i < flatFrame.length; i++) {
      const char = flatFrame[i];
      const prevChar = this.prevFrame?.[i];

      if (prevChar === char && (!colors || this.prevFrame?.[i] === char)) {
        continue;
      }

      const x = (i % cols) * this.atlas.cellWidth;
      const y = Math.floor(i / cols) * this.atlas.cellHeight;

      const glyph = this.atlas.charMap.get(char);
      if (!glyph) continue;

      ctx.drawImage(
        this.atlas.canvas,
        glyph.x, glyph.y, glyph.w, glyph.h,
        x, y, glyph.w, glyph.h
      );

      if (colors) {
        const r = colors[i * 3];
        const g = colors[i * 3 + 1];
        const b = colors[i * 3 + 2];

        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, y, glyph.w, glyph.h);
        ctx.globalCompositeOperation = 'source-over';
      }

      changedCount++;
    }

    this.prevFrame = flatFrame;
  }

  invalidate(): void {
    this.prevFrame = null;
  }
}

export function benchmarkAtlasRendering(
  atlas: GlyphAtlas,
  frame: string[][],
  iterations: number = 10
): number {
  const canvas = document.createElement('canvas');
  const renderer = new AtlasRenderer(atlas, canvas);

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    renderer.render(frame);
  }
  const elapsed = performance.now() - start;

  return elapsed / iterations;
}
