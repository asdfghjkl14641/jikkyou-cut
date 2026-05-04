import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Hybrid API-key storage. Two stores in lockstep:
//   1. Encrypted .bin (Electron safeStorage / DPAPI on Windows) —
//      runtime canonical store.
//   2. Plaintext JSON backup at ~/Documents/jikkyou-cut-backup/api-keys.json —
//      so a future master-key rotation / corruption can't permanently
//      destroy the user's keys (we lost 50 Gemini keys to exactly that
//      failure on 2026-05-04).
//
// Save path (saveAt):
//   write encrypted .bin → read-back verify → mirror plaintext to backup.
//   The verify catches encryption-broken state at write time so we never
//   leave the user with a .bin that "saved" but won't decrypt later.
//
// Load path (loadAt):
//   try .bin → on decrypt failure, fall back to plaintext backup,
//   re-encrypting in place so subsequent reads are fast. The user keeps
//   their keys even after a DPAPI master-key rotation.

// ---- slot types & paths --------------------------------------------------

export type SingleSlot = 'gladia' | 'anthropic' | 'twitchClientSecret';
export type MultiSlot = 'youtube' | 'gemini';
export type AllSlot = SingleSlot | MultiSlot | 'twitchClientId';

const BIN_FILE: Record<SingleSlot | MultiSlot, string> = {
  gladia: 'apiKey.bin',
  anthropic: 'anthropicKey.bin',
  twitchClientSecret: 'twitchClientSecret.bin',
  youtube: 'youtubeApiKeys.bin',
  gemini: 'geminiApiKeys.bin',
};

const binPath = (slot: SingleSlot | MultiSlot) =>
  path.join(app.getPath('userData'), BIN_FILE[slot]);

// Documents/ chosen because: user can browse there in Explorer, OneDrive
// + 1Password etc. are typically pointed there, the file survives an
// uninstall, and no admin rights are required. NOT inside userData
// (where DPAPI failures could also nuke the recovery copy).
const backupDir = () => path.join(os.homedir(), 'Documents', 'jikkyou-cut-backup');
const backupFile = () => path.join(backupDir(), 'api-keys.json');

const WARNING_TEXT =
  'このファイルには API キーが平文で含まれています。他人と共有しないでください。' +
  '1Password / Bitwarden 等の安全な場所への追加コピーを推奨します。';

const SCHEMA_ID = 'jikkyou-cut-api-keys-v1' as const;

export interface ApiKeyBackup {
  $schema: typeof SCHEMA_ID;
  lastBackupAt: string;
  warning: string;
  keys: Partial<{
    gemini: string[];
    youtube: string[];
    gladia: string;
    anthropic: string;
    twitchClientId: string;
    twitchClientSecret: string;
  }>;
}

// ---- backup file I/O -----------------------------------------------------

// Single-process serialisation guard. Two concurrent saveAt() calls
// would otherwise read-modify-write the backup file racily.
let backupMutex: Promise<unknown> = Promise.resolve();
function withBackupLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = backupMutex.then(fn, fn);
  backupMutex = next.catch(() => undefined);
  return next;
}

async function readBackupRaw(): Promise<ApiKeyBackup | null> {
  try {
    const raw = await fs.readFile(backupFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ApiKeyBackup>;
    if (parsed?.$schema !== SCHEMA_ID) return null;
    if (!parsed.keys || typeof parsed.keys !== 'object') return null;
    return parsed as ApiKeyBackup;
  } catch {
    return null;
  }
}

function emptyBackup(): ApiKeyBackup {
  return {
    $schema: SCHEMA_ID,
    lastBackupAt: new Date().toISOString(),
    warning: WARNING_TEXT,
    keys: {},
  };
}

async function writeBackupAtomic(data: ApiKeyBackup): Promise<void> {
  await fs.mkdir(backupDir(), { recursive: true });
  const tmp = backupFile() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, backupFile());
}

async function patchBackup(
  patch: (data: ApiKeyBackup) => void,
): Promise<void> {
  await withBackupLock(async () => {
    const data = (await readBackupRaw()) ?? emptyBackup();
    patch(data);
    data.lastBackupAt = new Date().toISOString();
    data.warning = WARNING_TEXT;
    await writeBackupAtomic(data);
  });
}

// ---- core save/load with hybrid behaviour --------------------------------

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function setSlot(
  data: ApiKeyBackup,
  slot: AllSlot,
  value: string | string[] | null,
): void {
  if (value == null || (Array.isArray(value) && value.length === 0)) {
    delete data.keys[slot];
    return;
  }
  // Discriminated assignment so TS can narrow the value type per slot.
  if (slot === 'gemini' || slot === 'youtube') {
    if (Array.isArray(value)) data.keys[slot] = value;
    return;
  }
  if (typeof value === 'string') {
    data.keys[slot] = value;
  }
}

async function saveSingle(slot: SingleSlot, value: string): Promise<void> {
  if (!isEncryptionAvailable()) {
    throw new Error('この環境では安全なAPIキー保存に対応していません');
  }
  const target = binPath(slot);
  const encrypted = safeStorage.encryptString(value);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, encrypted);
  // Read-back verify. If this fails, the encrypted blob will not decrypt
  // later either — surface the problem now, not the next time the user
  // launches the app. We DON'T delete the .bin here because the backup
  // write below is the safety net.
  let verified: string | null = null;
  try {
    const buf = await fs.readFile(target);
    verified = safeStorage.decryptString(buf);
  } catch (err) {
    console.warn(`[secureStorage] save read-back decrypt failed for ${slot}:`, err);
  }
  if (verified !== value) {
    console.warn(
      `[secureStorage] save verification mismatch for ${slot} ` +
        `(decrypted len=${verified?.length ?? -1} vs intended len=${value.length})`,
    );
  }
  await patchBackup((d) => setSlot(d, slot, value));
}

async function saveMulti(slot: MultiSlot, values: string[]): Promise<void> {
  const cleaned = Array.from(
    new Set(values.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => k.length > 0)),
  );
  const target = binPath(slot);
  if (cleaned.length === 0) {
    await fs.rm(target, { force: true });
    await patchBackup((d) => setSlot(d, slot, null));
    return;
  }
  if (!isEncryptionAvailable()) {
    throw new Error('この環境では安全なAPIキー保存に対応していません');
  }
  const json = JSON.stringify(cleaned);
  const encrypted = safeStorage.encryptString(json);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, encrypted);
  let verifiedJson: string | null = null;
  try {
    const buf = await fs.readFile(target);
    verifiedJson = safeStorage.decryptString(buf);
  } catch (err) {
    console.warn(`[secureStorage] save read-back decrypt failed for ${slot}:`, err);
  }
  if (verifiedJson !== json) {
    console.warn(
      `[secureStorage] save verification mismatch for ${slot} ` +
        `(decrypted len=${verifiedJson?.length ?? -1} vs intended len=${json.length})`,
    );
  }
  await patchBackup((d) => setSlot(d, slot, cleaned));
}

async function loadSingle(slot: SingleSlot): Promise<string | null> {
  const target = binPath(slot);
  let buf: Buffer;
  try {
    buf = await fs.readFile(target);
  } catch {
    return null;
  }
  try {
    return safeStorage.decryptString(buf);
  } catch (err) {
    console.warn(`[secureStorage] .bin decrypt failed for ${slot}, trying backup:`, err);
  }
  const backup = await readBackupRaw();
  const value = backup?.keys?.[slot];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('APIキーの読み込みに失敗しました。再度設定してください');
  }
  console.log(`[secureStorage] recovered ${slot} from plaintext backup, re-encrypting`);
  try {
    await saveSingle(slot, value);
  } catch (err) {
    console.warn(`[secureStorage] re-encrypt after recovery failed for ${slot}:`, err);
  }
  return value;
}

async function loadMulti(slot: MultiSlot): Promise<string[]> {
  const target = binPath(slot);
  let raw: string | null = null;
  let buf: Buffer | null = null;
  try {
    buf = await fs.readFile(target);
  } catch {
    buf = null;
  }
  if (buf) {
    try {
      raw = safeStorage.decryptString(buf);
    } catch (err) {
      console.warn(`[secureStorage] .bin decrypt failed for ${slot}, trying backup:`, err);
    }
  }
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((k): k is string => typeof k === 'string' && k.length > 0);
      }
    } catch (err) {
      console.warn(`[secureStorage] ${slot} JSON parse failed:`, err);
    }
  }
  const backup = await readBackupRaw();
  const value = backup?.keys?.[slot];
  if (!Array.isArray(value) || value.length === 0) return [];
  console.log(`[secureStorage] recovered ${slot} (${value.length} items) from plaintext backup, re-encrypting`);
  try {
    await saveMulti(slot, value);
  } catch (err) {
    console.warn(`[secureStorage] re-encrypt after recovery failed for ${slot}:`, err);
  }
  return value;
}

async function deleteSlot(slot: SingleSlot | MultiSlot): Promise<void> {
  await fs.rm(binPath(slot), { force: true });
  await patchBackup((d) => setSlot(d, slot, null));
}

async function existsSlot(slot: SingleSlot | MultiSlot): Promise<boolean> {
  try {
    await fs.access(binPath(slot));
    return true;
  } catch {
    // .bin missing — fall back to backup so multi-key sections render
    // correctly on a recovered install where only the backup survived.
    const backup = await readBackupRaw();
    const value = backup?.keys?.[slot];
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === 'string' && value.length > 0;
  }
}

// ---- public API: Gladia --------------------------------------------------

export const saveSecret = (value: string) => saveSingle('gladia', value);
export const loadSecret = () => loadSingle('gladia');
export const deleteSecret = () => deleteSlot('gladia');
export const hasSecret = () => existsSlot('gladia');

// ---- public API: Anthropic -----------------------------------------------

export const saveAnthropicSecret = (value: string) => saveSingle('anthropic', value);
export const loadAnthropicSecret = () => loadSingle('anthropic');
export const deleteAnthropicSecret = () => deleteSlot('anthropic');
export const hasAnthropicSecret = () => existsSlot('anthropic');

// ---- public API: Twitch Client Secret ------------------------------------

export const saveTwitchSecret = (value: string) => saveSingle('twitchClientSecret', value);
export const loadTwitchSecret = () => loadSingle('twitchClientSecret');
export const deleteTwitchSecret = () => deleteSlot('twitchClientSecret');
export const hasTwitchSecret = () => existsSlot('twitchClientSecret');

// ---- public API: YouTube multi-key ---------------------------------------

const YT_KEYS_JSON_MAX_BYTES = 100_000;

export async function saveYoutubeApiKeys(keys: string[]): Promise<void> {
  const json = JSON.stringify(keys ?? []);
  if (json.length > YT_KEYS_JSON_MAX_BYTES) {
    throw new Error(
      `YouTube API keys payload too large: ${json.length} chars (max ${YT_KEYS_JSON_MAX_BYTES})`,
    );
  }
  await saveMulti('youtube', keys ?? []);
}

export const loadYoutubeApiKeys = () => loadMulti('youtube');
export const clearYoutubeApiKeys = () => deleteSlot('youtube');
export const hasYoutubeApiKeys = () => existsSlot('youtube');
export async function countYoutubeApiKeys(): Promise<number> {
  return (await loadYoutubeApiKeys()).length;
}

// ---- public API: Gemini multi-key ----------------------------------------

const GEMINI_KEYS_JSON_MAX_BYTES = 100_000;

export async function saveGeminiApiKeys(keys: string[]): Promise<void> {
  const json = JSON.stringify(keys ?? []);
  if (json.length > GEMINI_KEYS_JSON_MAX_BYTES) {
    throw new Error(
      `Gemini API keys payload too large: ${json.length} chars (max ${GEMINI_KEYS_JSON_MAX_BYTES})`,
    );
  }
  await saveMulti('gemini', keys ?? []);
}

export const loadGeminiApiKeys = () => loadMulti('gemini');
export const clearGeminiApiKeys = () => deleteSlot('gemini');
export const hasGeminiApiKeys = () => existsSlot('gemini');
export async function countGeminiApiKeys(): Promise<number> {
  return (await loadGeminiApiKeys()).length;
}

// ---- backup-management surface (used by IPC + UI) ------------------------

// First-run sync: read every existing .bin, copy whatever decrypts into
// the plaintext backup. Idempotent — running it on every boot lets us
// catch the case where the user added keys before this feature shipped
// (no backup exists yet) AND the case where a slot was modified outside
// our save path (manual file edit, etc.).
export async function ensureBackupInitialized(opts: {
  twitchClientId?: string | null;
}): Promise<void> {
  await withBackupLock(async () => {
    const existing = await readBackupRaw();
    const data = existing ?? emptyBackup();

    // Only fill slots that are currently missing in the backup. Don't
    // overwrite slots we already have — the backup may contain keys
    // recovered from a damaged .bin that no longer decrypts.
    const tryFillSingle = async (slot: SingleSlot) => {
      if (typeof data.keys[slot] === 'string') return;
      try {
        const buf = await fs.readFile(binPath(slot));
        const v = safeStorage.decryptString(buf);
        if (v) (data.keys as Record<string, unknown>)[slot] = v;
      } catch {
        /* .bin missing or undecryptable — leave slot empty */
      }
    };
    const tryFillMulti = async (slot: MultiSlot) => {
      if (Array.isArray(data.keys[slot])) return;
      try {
        const buf = await fs.readFile(binPath(slot));
        const json = safeStorage.decryptString(buf);
        const arr = JSON.parse(json) as unknown;
        if (Array.isArray(arr)) {
          const cleaned = arr.filter((k): k is string => typeof k === 'string' && k.length > 0);
          if (cleaned.length > 0) (data.keys as Record<string, unknown>)[slot] = cleaned;
        }
      } catch {
        /* .bin missing or undecryptable */
      }
    };

    await tryFillSingle('gladia');
    await tryFillSingle('anthropic');
    await tryFillSingle('twitchClientSecret');
    await tryFillMulti('youtube');
    await tryFillMulti('gemini');

    // twitchClientId is plaintext in config.json; mirror it for export
    // convenience, but only if not already set.
    if (typeof opts.twitchClientId === 'string' && opts.twitchClientId.length > 0
        && typeof data.keys.twitchClientId !== 'string') {
      data.keys.twitchClientId = opts.twitchClientId;
    }

    data.lastBackupAt = new Date().toISOString();
    data.warning = WARNING_TEXT;
    await writeBackupAtomic(data);

    // 2026-05-04 — Reverse-direction sync for multi-slots. The user can
    // edit ~/Documents/jikkyou-cut-backup/api-keys.json externally
    // (manual paste, scripts/import-keys.cjs bulk import) while the app
    // is closed. Without this step the next launch happily decrypts a
    // STALE .bin (because GCM still verifies) and the rotator never
    // sees the newly-pasted keys. Push backup → .bin only when backup
    // strictly contains MORE keys than .bin, so a UI-side delete (.bin
    // gets fewer keys via saveMulti) doesn't get overruled.
    for (const slot of ['gemini', 'youtube'] as const) {
      const backupArr = data.keys[slot];
      if (!Array.isArray(backupArr) || backupArr.length === 0) continue;
      let binCount = 0;
      try {
        const buf = await fs.readFile(binPath(slot));
        const json = safeStorage.decryptString(buf);
        const arr = JSON.parse(json) as unknown;
        if (Array.isArray(arr)) {
          binCount = arr.filter((k): k is string => typeof k === 'string' && k.length > 0).length;
        }
      } catch {
        binCount = 0;
      }
      if (backupArr.length > binCount) {
        console.log(
          `[secureStorage] backup has more ${slot} keys (${backupArr.length}) than .bin (${binCount}); resyncing .bin`,
        );
        try {
          await saveMulti(slot, backupArr);
        } catch (err) {
          console.warn(`[secureStorage] backup→.bin resync failed for ${slot}:`, err);
        }
      }
    }
  });
}

export async function updateTwitchClientIdInBackup(value: string | null): Promise<void> {
  await patchBackup((d) => setSlot(d, 'twitchClientId', value));
}

export interface BackupStatus {
  filePath: string;
  exists: boolean;
  lastBackupAt: string | null;
  counts: {
    gemini: number;
    youtube: number;
    gladia: boolean;
    anthropic: boolean;
    twitchClientId: boolean;
    twitchClientSecret: boolean;
  };
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const fp = backupFile();
  const data = await readBackupRaw();
  return {
    filePath: fp,
    exists: data !== null,
    lastBackupAt: data?.lastBackupAt ?? null,
    counts: {
      gemini: Array.isArray(data?.keys?.gemini) ? data!.keys.gemini!.length : 0,
      youtube: Array.isArray(data?.keys?.youtube) ? data!.keys.youtube!.length : 0,
      gladia: typeof data?.keys?.gladia === 'string' && data.keys.gladia.length > 0,
      anthropic: typeof data?.keys?.anthropic === 'string' && data.keys.anthropic.length > 0,
      twitchClientId:
        typeof data?.keys?.twitchClientId === 'string' && data.keys.twitchClientId.length > 0,
      twitchClientSecret:
        typeof data?.keys?.twitchClientSecret === 'string' && data.keys.twitchClientSecret.length > 0,
    },
  };
}

export function backupFolderPath(): string {
  return backupDir();
}

// ---- export / import -----------------------------------------------------

// Build the JSON the user will save / hand to another machine. We use
// the SAME shape as the on-disk backup so import can accept either
// format interchangeably.
export async function buildExport(opts: {
  twitchClientId: string | null;
}): Promise<ApiKeyBackup> {
  const data = emptyBackup();
  const gladia = await loadSingle('gladia').catch(() => null);
  if (gladia) data.keys.gladia = gladia;
  const anthropic = await loadSingle('anthropic').catch(() => null);
  if (anthropic) data.keys.anthropic = anthropic;
  const twitchSec = await loadSingle('twitchClientSecret').catch(() => null);
  if (twitchSec) data.keys.twitchClientSecret = twitchSec;
  const yt = await loadMulti('youtube');
  if (yt.length > 0) data.keys.youtube = yt;
  const gem = await loadMulti('gemini');
  if (gem.length > 0) data.keys.gemini = gem;
  if (opts.twitchClientId) data.keys.twitchClientId = opts.twitchClientId;
  return data;
}

export interface ImportPlan {
  // Per-slot diff vs current state, used by the UI to confirm.
  gemini: { incoming: number; current: number };
  youtube: { incoming: number; current: number };
  gladia: { incoming: boolean; current: boolean };
  anthropic: { incoming: boolean; current: boolean };
  twitchClientId: { incoming: string | null; current: string | null };
  twitchClientSecret: { incoming: boolean; current: boolean };
  invalid: Array<{ slot: AllSlot; reason: string }>;
}

const GOOGLE_KEY_RE = /^AIza[A-Za-z0-9_-]{30,}$/;

function validateForSlot(slot: AllSlot, value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'empty';
  if (slot === 'gemini' || slot === 'youtube') {
    return GOOGLE_KEY_RE.test(value) ? null : 'AIza... 形式ではありません';
  }
  if (slot === 'anthropic') {
    return value.startsWith('sk-ant-') && value.length > 50 ? null : 'sk-ant-... 形式ではありません';
  }
  return null;
}

export interface ParsedImport {
  data: ApiKeyBackup;
  plan: ImportPlan;
}

export async function parseImport(
  raw: string,
  current: { twitchClientId: string | null },
): Promise<ParsedImport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('JSON の解析に失敗しました: ' + (err instanceof Error ? err.message : String(err)));
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON の構造が不正です');
  }
  const obj = parsed as Partial<ApiKeyBackup>;
  if (obj.$schema !== SCHEMA_ID) {
    throw new Error(`未知のスキーマ: ${obj.$schema} (期待値 ${SCHEMA_ID})`);
  }
  if (!obj.keys || typeof obj.keys !== 'object') {
    throw new Error('keys フィールドが見つかりません');
  }

  const incomingKeys = obj.keys;
  const invalid: ImportPlan['invalid'] = [];

  // Filter array slots to valid entries; surface each rejected key as
  // an invalid-row so the UI can show what was dropped.
  const filterArr = (slot: 'gemini' | 'youtube'): string[] => {
    const arr = incomingKeys[slot];
    if (!Array.isArray(arr)) return [];
    const ok: string[] = [];
    for (const v of arr) {
      const reason = validateForSlot(slot, v as string);
      if (reason) invalid.push({ slot, reason });
      else ok.push(v as string);
    }
    return Array.from(new Set(ok.map((k) => k.trim()).filter((k) => k.length > 0)));
  };
  const gem = filterArr('gemini');
  const yt = filterArr('youtube');

  const validateOpt = (slot: 'gladia' | 'anthropic' | 'twitchClientId' | 'twitchClientSecret'): string | undefined => {
    const v = incomingKeys[slot];
    if (typeof v !== 'string' || v.length === 0) return undefined;
    const reason = validateForSlot(slot, v);
    if (reason) {
      invalid.push({ slot, reason });
      return undefined;
    }
    return v;
  };
  const gladia = validateOpt('gladia');
  const anthropic = validateOpt('anthropic');
  const twClientId = validateOpt('twitchClientId') ?? null;
  const twClientSec = validateOpt('twitchClientSecret');

  const cleaned: ApiKeyBackup = {
    $schema: SCHEMA_ID,
    lastBackupAt: typeof obj.lastBackupAt === 'string' ? obj.lastBackupAt : new Date().toISOString(),
    warning: WARNING_TEXT,
    keys: {
      ...(gem.length > 0 && { gemini: gem }),
      ...(yt.length > 0 && { youtube: yt }),
      ...(gladia && { gladia }),
      ...(anthropic && { anthropic }),
      ...(twClientId && { twitchClientId: twClientId }),
      ...(twClientSec && { twitchClientSecret: twClientSec }),
    },
  };

  // Build diff vs current persisted state
  const curGemini = (await loadMulti('gemini')).length;
  const curYoutube = (await loadMulti('youtube')).length;
  const curGladia = !!(await loadSingle('gladia').catch(() => null));
  const curAnthropic = !!(await loadSingle('anthropic').catch(() => null));
  const curTwitchSec = !!(await loadSingle('twitchClientSecret').catch(() => null));

  const plan: ImportPlan = {
    gemini: { incoming: gem.length, current: curGemini },
    youtube: { incoming: yt.length, current: curYoutube },
    gladia: { incoming: !!gladia, current: curGladia },
    anthropic: { incoming: !!anthropic, current: curAnthropic },
    twitchClientId: { incoming: twClientId, current: current.twitchClientId },
    twitchClientSecret: { incoming: !!twClientSec, current: curTwitchSec },
    invalid,
  };

  return { data: cleaned, plan };
}

export type ImportMode = 'merge' | 'replace';

export interface ApplyImportResult {
  applied: { slot: AllSlot; count: number }[];
  twitchClientId: string | null | 'unchanged';
}

// Apply a parsed import. Returns enough info for the caller (main IPC
// handler) to also persist twitchClientId into AppConfig.
export async function applyImport(
  parsed: ApiKeyBackup,
  mode: ImportMode,
): Promise<ApplyImportResult> {
  const result: ApplyImportResult = { applied: [], twitchClientId: 'unchanged' };
  const k = parsed.keys;

  // Single-value slots: incoming value (when present) replaces existing.
  // Replace mode also clears slots not present in the import.
  if (typeof k.gladia === 'string') {
    await saveSingle('gladia', k.gladia);
    result.applied.push({ slot: 'gladia', count: 1 });
  } else if (mode === 'replace') {
    await deleteSlot('gladia');
  }
  if (typeof k.anthropic === 'string') {
    await saveSingle('anthropic', k.anthropic);
    result.applied.push({ slot: 'anthropic', count: 1 });
  } else if (mode === 'replace') {
    await deleteSlot('anthropic');
  }
  if (typeof k.twitchClientSecret === 'string') {
    await saveSingle('twitchClientSecret', k.twitchClientSecret);
    result.applied.push({ slot: 'twitchClientSecret', count: 1 });
  } else if (mode === 'replace') {
    await deleteSlot('twitchClientSecret');
  }

  // Multi-key slots: merge unions; replace overwrites.
  for (const slot of ['gemini', 'youtube'] as const) {
    const incoming = Array.isArray(k[slot]) ? (k[slot] as string[]) : [];
    if (mode === 'replace') {
      await saveMulti(slot, incoming);
      result.applied.push({ slot, count: incoming.length });
    } else if (incoming.length > 0) {
      const current = await loadMulti(slot);
      const merged = Array.from(new Set([...current, ...incoming]));
      await saveMulti(slot, merged);
      result.applied.push({ slot, count: merged.length });
    }
  }

  if (typeof k.twitchClientId === 'string' && k.twitchClientId.length > 0) {
    result.twitchClientId = k.twitchClientId;
  } else if (mode === 'replace') {
    result.twitchClientId = null;
  }

  return result;
}
