import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Stores the API key as ciphertext using Electron's safeStorage (DPAPI on
// Windows). The plaintext key never lands on disk and never leaves this
// module to the renderer.
const getKeyFilePath = () => path.join(app.getPath('userData'), 'apiKey.bin');

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export async function saveSecret(value: string): Promise<void> {
  if (!isEncryptionAvailable()) {
    throw new Error('この環境では安全なAPIキー保存に対応していません');
  }
  const encrypted = safeStorage.encryptString(value);
  const p = getKeyFilePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, encrypted);
}

// Decrypts and returns the secret. Callers should drop the reference as soon
// as the key has been used. Errors are intentionally generic — the original
// exception message is dropped rather than re-thrown to avoid leaking key
// fragments through stack traces or logs.
export async function loadSecret(): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(getKeyFilePath());
  } catch {
    return null;
  }
  try {
    return safeStorage.decryptString(buf);
  } catch {
    throw new Error('APIキーの読み込みに失敗しました。再度設定してください');
  }
}

export async function deleteSecret(): Promise<void> {
  await fs.rm(getKeyFilePath(), { force: true });
}

export async function hasSecret(): Promise<boolean> {
  try {
    await fs.access(getKeyFilePath());
    return true;
  } catch {
    return false;
  }
}
