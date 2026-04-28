import { protocol } from 'electron';
import { createReadStream, promises as fsPromises } from 'node:fs';
import type { Stats } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';

// `protocol.registerSchemesAsPrivileged` must be called BEFORE `app.ready`,
// so this is split from `handleMediaProtocol` (which must be called AFTER ready).
export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
      },
    },
  ]);
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
};

const mimeOf = (filePath: string): string =>
  MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

// Build a Response from a (possibly partial) read of the file. Range support
// is required so the <video> element can seek; without it the browser only
// receives a 200 with the entire body and disables seeking.
export function handleMediaProtocol() {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));

    let stat: Stats;
    try {
      stat = await fsPromises.stat(filePath);
    } catch {
      return new Response('Not Found', { status: 404 });
    }
    const fileSize = stat.size;
    const contentType = mimeOf(filePath);

    const range = request.headers.get('Range') ?? request.headers.get('range');
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m && m[1] != null) {
        const start = Number.parseInt(m[1], 10);
        const end =
          m[2] != null && m[2].length > 0
            ? Math.min(Number.parseInt(m[2], 10), fileSize - 1)
            : fileSize - 1;

        if (start >= fileSize || start > end) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` },
          });
        }

        const chunkSize = end - start + 1;
        const nodeStream = createReadStream(filePath, { start, end });
        return new Response(
          Readable.toWeb(nodeStream) as unknown as ReadableStream,
          {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Content-Type': contentType,
            },
          },
        );
      }
    }

    // No range — return the whole file but advertise Range support so future
    // requests will go through the 206 path.
    const nodeStream = createReadStream(filePath);
    return new Response(
      Readable.toWeb(nodeStream) as unknown as ReadableStream,
      {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(fileSize),
          'Content-Type': contentType,
        },
      },
    );
  });
}
