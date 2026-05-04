// 段階 X3.5 — task-tray integration.
//
// Windows-only by design. macOS / Linux are no-ops here; the spec
// scopes jikkyou-cut to Windows for this iteration. The platform
// guard avoids the (rare but real) failure modes of Tray on Linux
// distros without a system tray daemon.
//
// Two tray icons live in resources/:
//   - tray-icon.png        : default state
//   - tray-icon-live.png   : same icon + a small red dot to signal
//                            "someone is live right now". Swapped in
//                            via setImage() when streamMonitor reports
//                            liveStreams > 0.
//
// Tooltip + context-menu label also reflect the live count so the user
// can see who's broadcasting without expanding the menu.

import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';

let tray: Tray | null = null;
let menuRef: Menu | null = null;
let lastLiveCount = 0;
let hasShownTrayBalloon = false;

// Resolves the icon path for both dev (asset under repo root) and
// packaged builds (bundled under process.resourcesPath). The same
// directory layout already works for yt-dlp.exe, so we mirror it.
function iconPath(filename: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath || '', filename);
  }
  return path.join(app.getAppPath(), 'resources', filename);
}

function buildContextMenu(opts: {
  liveCount: number;
  onShow: () => void;
  onOpenMonitoredCreators: () => void;
  onQuit: () => void;
}): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'jikkyou-cut を開く',
      click: () => opts.onShow(),
    },
    {
      label: '登録チャンネル を開く',
      click: () => opts.onOpenMonitoredCreators(),
    },
    { type: 'separator' },
    {
      // `enabled: false` would grey it out; we keep it enabled so the
      // text colour stays readable. It's purely informational — clicks
      // are no-ops.
      id: 'monitor-status',
      label:
        opts.liveCount > 0
          ? `配信監視: ● ${opts.liveCount} 人配信中`
          : '配信監視: 監視中',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => opts.onQuit(),
    },
  ]);
}

export function createTray(opts: {
  getMainWindow: () => BrowserWindow | null;
  showMainWindow: () => void;
  openMonitoredCreators: () => void;
  quit: () => void;
}): Tray | null {
  if (process.platform !== 'win32') {
    // macOS / Linux: silently skip. The window's close button reverts
    // to default behaviour (quit on all-windows-closed for non-darwin)
    // since we never inserted the tray-aware close handler in those
    // OSes either.
    return null;
  }
  if (tray) return tray;

  const img = nativeImage.createFromPath(iconPath('tray-icon.png'));
  // If the file is missing or unreadable, createFromPath returns an
  // empty image. Tray still constructs but the icon is blank — log
  // loudly so the dev notices.
  if (img.isEmpty()) {
    console.warn('[tray] icon failed to load from', iconPath('tray-icon.png'));
  }
  tray = new Tray(img);
  tray.setToolTip('jikkyou-cut');

  menuRef = buildContextMenu({
    liveCount: 0,
    onShow: opts.showMainWindow,
    onOpenMonitoredCreators: opts.openMonitoredCreators,
    onQuit: opts.quit,
  });
  tray.setContextMenu(menuRef);

  // Left click → toggle window visibility. Twitch / Discord / 1Password
  // all use this idiom and users expect it.
  tray.on('click', () => {
    const w = opts.getMainWindow();
    if (!w) {
      opts.showMainWindow();
      return;
    }
    if (w.isVisible() && !w.isMinimized()) {
      w.hide();
    } else {
      opts.showMainWindow();
    }
  });

  return tray;
}

// Push an updated live-count to the tray. Called by the streamMonitor
// status listener wired in main/index.ts. Cheap to call repeatedly —
// no-ops when the count is unchanged so we don't churn the menu / icon
// on every poll.
export function updateTrayLiveCount(opts: {
  liveCount: number;
  showMainWindow: () => void;
  openMonitoredCreators: () => void;
  quit: () => void;
}): void {
  if (!tray) return;
  if (opts.liveCount === lastLiveCount) return;
  lastLiveCount = opts.liveCount;

  // Tooltip
  tray.setToolTip(
    opts.liveCount > 0
      ? `jikkyou-cut(${opts.liveCount} 人配信中)`
      : 'jikkyou-cut',
  );

  // Icon swap
  const filename = opts.liveCount > 0 ? 'tray-icon-live.png' : 'tray-icon.png';
  const img = nativeImage.createFromPath(iconPath(filename));
  if (!img.isEmpty()) tray.setImage(img);

  // Rebuild menu so the "配信監視: ●" line reflects the new count.
  // Updating a single MenuItem.label in Electron requires rebuilding
  // the whole menu anyway (Menu objects are immutable post-build).
  menuRef = buildContextMenu({
    liveCount: opts.liveCount,
    onShow: opts.showMainWindow,
    onOpenMonitoredCreators: opts.openMonitoredCreators,
    onQuit: opts.quit,
  });
  tray.setContextMenu(menuRef);
}

// First-time minimize-to-tray balloon. Fires at most once per process
// lifetime so a user closing/restoring repeatedly doesn't get spammed.
// On Windows 10/11 modern toasts have replaced traditional balloons,
// but `displayBalloon` still works as a thin shim.
export function showFirstHideBalloon(): void {
  if (!tray || hasShownTrayBalloon) return;
  hasShownTrayBalloon = true;
  try {
    tray.displayBalloon({
      title: 'jikkyou-cut',
      content: 'タスクトレイで動作中です。完全終了はトレイメニューから。',
    });
  } catch (err) {
    // Some Windows configurations (no notification permission, group
    // policy) reject displayBalloon. Failure here is purely cosmetic.
    console.warn('[tray] displayBalloon failed:', err);
  }
}

export function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
  menuRef = null;
  lastLiveCount = 0;
}
