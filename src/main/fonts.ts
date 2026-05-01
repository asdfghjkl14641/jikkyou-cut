import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AvailableFont,
  DownloadResult,
  FontDownloadStatus,
  InstalledFont,
} from '../common/types';

// Subtitle fonts live in `userData/fonts/`. One file per family. Filename is
// the family with whitespace replaced by underscore, e.g.
// "Noto Sans JP" → "Noto_Sans_JP.ttf".
const FONTS_DIR_NAME = 'fonts';
const fontsDir = (): string => path.join(app.getPath('userData'), FONTS_DIR_NAME);

const sanitiseFileName = (family: string): string =>
  family.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');

// User-Agent string that nudges Google Fonts CSS API to return TTF URLs in
// its @font-face blocks (default returns WOFF2, which FFmpeg can't reliably
// read for subtitle burn-in).
const TTF_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

// Curated catalogue of Japanese-friendly Google Fonts targeted at gaming
// commentary / clip workflows. The URL is the canonical specimen page so
// it can be linked from a future settings UI. The actual file download
// goes through the CSS API (constructed from the family name).
const CURATED_FONTS_DEF: ReadonlyArray<{ family: string; category: string }> = [
  { family: 'Noto Sans JP', category: 'japanese' },
  { family: 'M PLUS Rounded 1c', category: 'japanese-display' },
  { family: 'Klee One', category: 'japanese' },
  { family: 'Yusei Magic', category: 'japanese-display' },
  { family: 'DotGothic16', category: 'japanese-display' },
  { family: 'Reggae One', category: 'japanese-display' },
  { family: 'Train One', category: 'japanese-display' },
  { family: 'RocknRoll One', category: 'japanese-display' },
  { family: 'Zen Maru Gothic', category: 'japanese' },
  { family: 'Mochiy Pop One', category: 'japanese-display' },
  { family: 'Hachi Maru Pop', category: 'japanese-display' },
  { family: 'New Tegomin', category: 'japanese-display' },
];

const specimenUrl = (family: string): string =>
  `https://fonts.google.com/specimen/${family.replace(/\s+/g, '+')}`;

export async function listAvailableFonts(): Promise<AvailableFont[]> {
  const installed = new Set(
    (await listInstalledFonts()).map((f) => f.family),
  );
  return CURATED_FONTS_DEF.map((f) => ({
    family: f.family,
    category: f.category,
    url: specimenUrl(f.family),
    installed: installed.has(f.family),
  }));
}

export async function listInstalledFonts(): Promise<InstalledFont[]> {
  const dir = fontsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: InstalledFont[] = [];
  for (const name of entries) {
    if (!/\.(ttf|otf)$/i.test(name)) continue;
    // Reverse the sanitisation for display: strip extension, _ → space.
    const family = path.basename(name, path.extname(name)).replace(/_/g, ' ');
    out.push({
      family,
      filePath: path.join(dir, name),
      fileName: name,
      source: 'google-fonts',
    });
  }
  return out;
}

export async function removeFont(family: string): Promise<void> {
  const dir = fontsDir();
  const stem = sanitiseFileName(family);
  for (const ext of ['.ttf', '.otf']) {
    await fs.rm(path.join(dir, stem + ext), { force: true });
  }
}

type ProgressCb = (
  family: string,
  status: FontDownloadStatus,
  error?: string,
) => void;

async function downloadOne(
  family: string,
  onProgress: ProgressCb,
): Promise<{ family: string; success: boolean; error?: string; filePath?: string }> {
  onProgress(family, 'starting');
  try {
    // 1. Fetch the CSS that Google Fonts would normally embed in a page.
    //    With our desktop UA the response references `.ttf` URLs.
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}`;
    const cssResp = await fetch(cssUrl, {
      headers: { 'User-Agent': TTF_USER_AGENT },
    });
    if (!cssResp.ok) {
      throw new Error(`CSS fetch failed: HTTP ${cssResp.status}`);
    }
    const cssText = await cssResp.text();

    const ttfMatch = cssText.match(/src:\s*url\((https:\/\/[^)]+\.ttf)\)/);
    if (!ttfMatch || !ttfMatch[1]) {
      throw new Error('TTF URL not found in CSS response');
    }
    const fontUrl = ttfMatch[1];

    // 2. Pull the actual font binary.
    const fontResp = await fetch(fontUrl);
    if (!fontResp.ok) {
      throw new Error(`Font fetch failed: HTTP ${fontResp.status}`);
    }
    const buffer = Buffer.from(await fontResp.arrayBuffer());

    // 3. Persist into userData/fonts/.
    await fs.mkdir(fontsDir(), { recursive: true });
    const fileName = `${sanitiseFileName(family)}.ttf`;
    const filePath = path.join(fontsDir(), fileName);
    await fs.writeFile(filePath, buffer);

    onProgress(family, 'done');
    return { family, success: true, filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress(family, 'failed', msg);
    return { family, success: false, error: msg };
  }
}

export async function downloadFonts(
  families: string[],
  onProgress: ProgressCb,
): Promise<DownloadResult> {
  const settled = await Promise.allSettled(
    families.map((f) => downloadOne(f, onProgress)),
  );
  const succeeded: string[] = [];
  const failed: { family: string; error: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value.success) {
        succeeded.push(r.value.family);
      } else {
        failed.push({
          family: r.value.family,
          error: r.value.error ?? 'unknown',
        });
      }
    } else {
      const msg =
        r.reason instanceof Error ? r.reason.message : String(r.reason);
      failed.push({ family: families[i] ?? '?', error: msg });
    }
  });
  return { succeeded, failed };
}
