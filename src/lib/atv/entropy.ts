export interface RleRun {
  value: number;
  count: number;
}

export function rleEncode(values: number[]): RleRun[] {
  if (!values.length) return [];
  const runs: RleRun[] = [];
  let cur = values[0], count = 1;
  for (let i = 1; i < values.length; i++) {
    if (values[i] === cur && count < 65535) {
      count++;
    } else {
      runs.push({ value: cur, count });
      cur = values[i];
      count = 1;
    }
  }
  runs.push({ value: cur, count });
  return runs;
}

export function rleDecode(runs: RleRun[]): number[] {
  const out: number[] = [];
  for (const r of runs) {
    for (let i = 0; i < r.count; i++) out.push(r.value);
  }
  return out;
}

export interface HuffmanNode {
  freq: number;
  value?: number;
  left?: HuffmanNode;
  right?: HuffmanNode;
}

export type HuffmanTable = Map<number, { bits: number; len: number }>;
export type HuffmanDecodeTable = Map<string, number>;

export function buildHuffmanTree(freqs: Map<number, number>): HuffmanNode {
  const nodes: HuffmanNode[] = [];
  for (const [value, freq] of freqs) {
    nodes.push({ freq, value });
  }
  if (nodes.length === 0) return { freq: 0, value: 0 };
  if (nodes.length === 1) return { freq: nodes[0].freq, left: nodes[0], right: { freq: 0, value: -1 } };

  while (nodes.length > 1) {
    nodes.sort((a, b) => a.freq - b.freq);
    const left = nodes.shift()!;
    const right = nodes.shift()!;
    nodes.push({ freq: left.freq + right.freq, left, right });
  }
  return nodes[0];
}

function buildCodes(node: HuffmanNode, prefix = 0, len = 0, table: HuffmanTable): void {
  if (node.value !== undefined) {
    table.set(node.value, { bits: prefix, len: Math.max(len, 1) });
    return;
  }
  if (node.left) buildCodes(node.left, prefix << 1, len + 1, table);
  if (node.right) buildCodes(node.right, (prefix << 1) | 1, len + 1, table);
}

export function buildHuffmanTable(freqs: Map<number, number>): HuffmanTable {
  const tree = buildHuffmanTree(freqs);
  const table: HuffmanTable = new Map();
  buildCodes(tree, 0, 0, table);
  return table;
}

export function buildDecodeTable(table: HuffmanTable): HuffmanDecodeTable {
  const decode: HuffmanDecodeTable = new Map();
  for (const [value, { bits, len }] of table) {
    decode.set(bits.toString(2).padStart(len, "0"), value);
  }
  return decode;
}

export class BitWriter {
  private buf: number[] = [];
  private current = 0;
  private bitPos = 0;

  writeBits(value: number, numBits: number): void {
    for (let i = numBits - 1; i >= 0; i--) {
      const bit = (value >> i) & 1;
      this.current = (this.current << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.buf.push(this.current);
        this.current = 0;
        this.bitPos = 0;
      }
    }
  }

  flush(): Uint8Array {
    if (this.bitPos > 0) {
      this.buf.push(this.current << (8 - this.bitPos));
    }
    return new Uint8Array(this.buf);
  }

  get byteLength(): number {
    return this.buf.length + (this.bitPos > 0 ? 1 : 0);
  }
}

export class BitReader {
  private pos = 0;
  private bitPos = 0;
  private current = 0;

  constructor(private data: Uint8Array) {
    this.current = data[0] ?? 0;
  }

  readBit(): number {
    const bit = (this.current >> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) {
      this.pos++;
      this.bitPos = 0;
      this.current = this.data[this.pos] ?? 0;
    }
    return bit;
  }

  readBits(n: number): number {
    let result = 0;
    for (let i = 0; i < n; i++) result = (result << 1) | this.readBit();
    return result;
  }

  get done(): boolean {
    return this.pos >= this.data.length;
  }
}

export function huffmanEncode(values: number[], table: HuffmanTable): Uint8Array {
  const writer = new BitWriter();
  for (const v of values) {
    const code = table.get(v);
    if (code) {
      writer.writeBits(code.bits, code.len);
    } else {
      writer.writeBits(0, 1);
    }
  }
  return writer.flush();
}

export function huffmanDecode(data: Uint8Array, decode: HuffmanDecodeTable, count: number): number[] {
  const reader = new BitReader(data);
  const result: number[] = [];
  let code = "";

  while (result.length < count && !reader.done) {
    code += reader.readBit().toString();
    const val = decode.get(code);
    if (val !== undefined) {
      result.push(val);
      code = "";
    }
    if (code.length > 24) { code = ""; result.push(0); }
  }
  return result;
}

export function computeFrequencies(values: number[]): Map<number, number> {
  const freqs = new Map<number, number>();
  for (const v of values) freqs.set(v, (freqs.get(v) ?? 0) + 1);
  return freqs;
}

export function serializeHuffmanTable(table: HuffmanTable): Uint8Array {
  const entries = Array.from(table.entries());
  const buf: number[] = [];
  buf.push((entries.length >> 8) & 0xff, entries.length & 0xff);
  for (const [value, { bits, len }] of entries) {
    buf.push((value >> 8) & 0xff, value & 0xff);
    buf.push(len & 0xff);
    buf.push((bits >> 24) & 0xff, (bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff);
  }
  return new Uint8Array(buf);
}

export function deserializeHuffmanTable(data: Uint8Array, offset = 0): { table: HuffmanTable; bytesRead: number } {
  const count = (data[offset] << 8) | data[offset + 1];
  const table: HuffmanTable = new Map();
  let p = offset + 2;
  for (let i = 0; i < count; i++) {
    const value = (data[p] << 8) | data[p + 1]; p += 2;
    const len = data[p++];
    const bits = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4;
    table.set(value, { bits, len });
  }
  return { table, bytesRead: p - offset };
}
