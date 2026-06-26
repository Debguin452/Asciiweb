export interface LibraryItem {
  id: string;
  name: string;
  createdAt: number;
  source: "recording" | "import";
  kind: "video" | "image";
  charset: string;
  asciiW: number;
  asciiH: number;
  frameCount: number;
  frames: number[][][];
  colorFrames?: number[][][][];
  thumbnail: string;
  fps?: number;
}

const DB_NAME = "asciiweb-library";
const DB_VERSION = 1;
const STORE = "items";

let _dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { _dbPromise = null; reject(req.error); };
    });
  }
  return _dbPromise;
}

export async function saveLibraryItem(item: LibraryItem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLibraryItems(): Promise<LibraryItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const items = (req.result as LibraryItem[]).sort((a, b) => b.createdAt - a.createdAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteLibraryItem(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function makeThumbnail(frames: number[][][], charset: string, asciiW: number, asciiH: number): string {
  const frame = frames[Math.floor(frames.length / 2)] ?? frames[0];
  if (!frame) return "";
  const maxRows = Math.min(asciiH, 14);
  const step = Math.max(1, Math.floor(asciiW / 48));
  return Array.from({ length: maxRows }, (_, y) =>
    Array.from({ length: Math.floor(asciiW / step) }, (_, xi) =>
      charset[frame[y]?.[xi*step] ?? 0] ?? " "
    ).join("")
  ).join("\n");
}

export function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
