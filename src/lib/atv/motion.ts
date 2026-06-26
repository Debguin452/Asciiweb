export interface MotionVector {
  dx: number;
  dy: number;
  sad: number;
}

export interface AtvToken {
  glyphId: number;
  colorId: number;
}

export interface DeltaEntry {
  cellIndex: number;
  token: AtvToken;
}

export interface MotionBlock {
  blockX: number;
  blockY: number;
  dx: number;
  dy: number;
}

const BLOCK_SIZE = 4;
const SEARCH_RADIUS = 8;

export function estimateMotion(
  curr: AtvToken[][],
  prev: AtvToken[][],
  rows: number,
  cols: number
): MotionBlock[] {
  const blocks: MotionBlock[] = [];
  const blockRows = Math.floor(rows / BLOCK_SIZE);
  const blockCols = Math.floor(cols / BLOCK_SIZE);

  for (let by = 0; by < blockRows; by++) {
    for (let bx = 0; bx < blockCols; bx++) {
      let bestDx = 0, bestDy = 0, bestSAD = Infinity;

      for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
        for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
          let sad = 0;
          for (let py = 0; py < BLOCK_SIZE; py++) {
            for (let px = 0; px < BLOCK_SIZE; px++) {
              const cy = by * BLOCK_SIZE + py;
              const cx = bx * BLOCK_SIZE + px;
              const sy = cy + dy, sx = cx + dx;
              const currTok = curr[cy]?.[cx];
              const prevTok = prev[Math.max(0, Math.min(rows - 1, sy))]?.[Math.max(0, Math.min(cols - 1, sx))];
              if (!currTok || !prevTok) { sad += 2; continue; }
              sad += currTok.glyphId !== prevTok.glyphId ? 1 : 0;
              sad += currTok.colorId !== prevTok.colorId ? 1 : 0;
            }
          }
          if (sad < bestSAD) { bestSAD = sad; bestDx = dx; bestDy = dy; }
        }
      }

      if (bestDx !== 0 || bestDy !== 0 || bestSAD < BLOCK_SIZE * BLOCK_SIZE) {
        blocks.push({ blockX: bx, blockY: by, dx: bestDx, dy: bestDy });
      }
    }
  }
  return blocks;
}

export function applyMotionPrediction(
  prev: AtvToken[][],
  motionBlocks: MotionBlock[],
  rows: number,
  cols: number
): AtvToken[][] {
  const predicted: AtvToken[][] = prev.map(row => [...row].map(t => ({ ...t })));

  for (const mb of motionBlocks) {
    const srcY = mb.blockY * BLOCK_SIZE + mb.dy;
    const srcX = mb.blockX * BLOCK_SIZE + mb.dx;
    for (let py = 0; py < BLOCK_SIZE; py++) {
      for (let px = 0; px < BLOCK_SIZE; px++) {
        const dy = mb.blockY * BLOCK_SIZE + py;
        const dx = mb.blockX * BLOCK_SIZE + px;
        if (dy >= rows || dx >= cols) continue;
        const sy = Math.max(0, Math.min(rows - 1, srcY + py));
        const sx = Math.max(0, Math.min(cols - 1, srcX + px));
        const src = prev[sy]?.[sx];
        if (src) predicted[dy][dx] = { ...src };
      }
    }
  }
  return predicted;
}

export function computeDelta(
  curr: AtvToken[][],
  predicted: AtvToken[][],
  rows: number,
  cols: number
): DeltaEntry[] {
  const deltas: DeltaEntry[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = curr[y]?.[x];
      const p = predicted[y]?.[x];
      if (!c) continue;
      if (!p || c.glyphId !== p.glyphId || c.colorId !== p.colorId) {
        deltas.push({ cellIndex: y * cols + x, token: c });
      }
    }
  }
  return deltas;
}

export function applyDelta(
  base: AtvToken[][],
  deltas: DeltaEntry[],
  rows: number,
  cols: number
): AtvToken[][] {
  const out: AtvToken[][] = base.map(row => [...row].map(t => ({ ...t })));
  for (const d of deltas) {
    const y = Math.floor(d.cellIndex / cols);
    const x = d.cellIndex % cols;
    if (y < rows && x < cols) out[y][x] = d.token;
  }
  return out;
}
