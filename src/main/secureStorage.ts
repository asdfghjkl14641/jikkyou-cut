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

// Defensive cap. DPAPI itself can handle MB-scale payloads, but we want
// a sanity ceiling so a UI bug or malicious paste can't fill the disk.
// 50 keys × ~50 chars ≈ 2.5 KB; 100 KB leaves 40× headroom.
const YT_KEYS_JSON_MAX_BYTES = 100_000;

export async function saveYoutubeApiKeys(keys: string[]): Promise<void> {
  // Trim + dedupe + drop empties. Set preserves first-seen order so the
  // user's intended ordering survives.
  const cleaned = Array.from(new Set(keys.map((k) => k.trim()).filter((k) => k.length > 0)));
  console.log(
    `[secureStorage] saveYoutubeApiKeys: received=${keys.length} cleaned=${cleaned.length}`,
  );
  if (cleaned.length === 0) {
    await deleteAt(youtubeKeysPath());
    console.log('[secureStorage] saveYoutubeApiKeys: cleared (empty input)');
    return;
  }
  const json = JSON.stringify(cleaned);
  console.log(`[secureStorage] saveYoutubeApiKeys: JSON length=${json.length} chars`);
  if (json.length > YT_KEYS_JSON_MAX_BYTES) {
    throw new Error(
      `YouTube API keys payload too large: ${json.length} chars (max ${YT_KEYS_JSON_MAX_BYTES})`,
    );
  }
  await saveAt(youtubeKeysPath(), json);
  // Sanity check what landed on disk — confirms encryption + write
  // both succeeded, surfaces "X went in but Y came out" mismatches.
  try {
    const stat = await fs.stat(youtubeKeysPath());
    console.log(
      `[secureStorage] saveYoutubeApiKeys: written ${stat.size} bytes for ${cleaned.length} keys`,
    );
  } catch {
    /* ignore — primary write already succeeded */
  }
}

export async function loadYoutubeApiKeys(): Promise<string[]> {
  const raw = await loadAt(youtubeKeysPath());
  if (!raw) {
    console.log('[secureStorage] loadYoutubeApiKeys: file missing → []');
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn(
        '[secureStorage] loadYoutubeApiKeys: parsed but not array → []',
      );
      return [];
    }
    const out = parsed.filter((k): k is string => typeof k === 'string' && k.length > 0);
    console.log(`[secureStorage] loadYoutubeApiKeys: loaded ${out.length} keys (raw JSON ${raw.length} chars)`);
    return out;
  } catch (err) {
    console.warn('[secureStorage] loadYoutubeApiKeys: JSON parse failed:', err);
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
