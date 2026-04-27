import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';

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

export function handleMediaProtocol() {
  protocol.handle('media', (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return net.fetch(pathToFileURL(filePath).toString());
  });
}
