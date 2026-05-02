import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Stores API keys as ciphertext using Electron's safeStorage (DPAPI on
// Windows). Plaintext keys never land on disk and never leave this
// module to the renderer.
//
// Two slots are exposed: the original Gladia key (transcription) and a
// new Anthropic key (AI title summarisation). Each lives in its own
// file so they're independently rotatable.

const gladiaPath = () => path.join(app.getPath('userData'), 'apiKey.bin');
const anthropicPath = () => path.join(app.getPath('userData'), 'anthropicKey.bin');

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function saveAt(p: string, value: string): Promise<void> {
  if (!isEncryptionAvailable()) {
    throw new Error('この環境では安全なAPIキー保存に対応していません');
  }
  const encrypted = safeStorage.encryptString(value);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, encrypted);
}

async function loadAt(p: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(p);
  } catch {
    return null;
  }
  try {
    return safeStorage.decryptString(buf);
  } catch {
    throw new Error('APIキーの読み込みに失敗しました。再度設定してください');
  }
}

async function deleteAt(p: string): Promise<void> {
  await fs.rm(p, { force: true });
}

async function existsAt(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---- Gladia ---------------------------------------------------------------

export const saveSecret = (value: string) => saveAt(gladiaPath(), value);
export const loadSecret = () => loadAt(gladiaPath());
export const deleteSecret = () => deleteAt(gladiaPath());
export const hasSecret = () => existsAt(gladiaPath());

// ---- Anthropic ------------------------------------------------------------

export const saveAnthropicSecret = (value: string) => saveAt(anthropicPath(), value);
export const loadAnthropicSecret = () => loadAt(anthropicPath());
export const deleteAnthropicSecret = () => deleteAt(anthropicPath());
export const hasAnthropicSecret = () => existsAt(anthropicPath());

// ---- YouTube Data API (multi-key for quota rotation) ----------------------
// Stored as a single ciphertext blob containing the JSON-encoded array.
// We don't encrypt each key separately because the user typically rotates
// the whole set together (paste 10 keys, save, done).
const youtubeKeysPath = () => path.join(app.getPath('userData'), 'youtubeApiKeys.bin');

export async function saveYoutubeApiKeys(keys: string[]): Promise<void> {
  const cleaned = keys.map((k) => k.trim()).filter((k) => k.length > 0);
  if (cleaned.length === 0) {
    await deleteAt(youtubeKeysPath());
    return;
  }
  await saveAt(youtubeKeysPath(), JSON.stringify(cleaned));
}

export async function loadYoutubeApiKeys(): Promise<string[]> {
  const raw = await loadAt(youtubeKeysPath());
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string' && k.length > 0);
  } catch {
    return [];
  }
}

export async function clearYoutubeApiKeys(): Promise<void> {
  await deleteAt(youtubeKeysPath());
}

export async function hasYoutubeApiKeys(): Promise<boolean> {
  return existsAt(youtubeKeysPath());
}

export async function countYoutubeApiKeys(): Promise<number> {
  return (await loadYoutubeApiKeys()).length;
}
