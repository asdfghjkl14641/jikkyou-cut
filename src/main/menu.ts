import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { diagnoseDataCollection } from './dataCollection/diagnose';

export function buildMenu(opts: {
  getMainWindow: () => BrowserWindow | null;
  // 段階 X3.5 — explicit quit handler routed through actuallyQuit so
  // the close-to-tray hook in main/index.ts knows this is a user-
  // initiated quit and doesn't re-hide the window.
  onQuit: () => void;
}) {
  const { getMainWindow } = opts;
  const send = (channel: string) => () => {
    getMainWindow()?.webContents.send(channel);
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'ファイル',
      submenu: [
        {
          label: '開く...',
          accelerator: 'CmdOrCtrl+O',
          click: send('menu:openFile'),
        },
        {
          label: '設定...',
          accelerator: 'CmdOrCtrl+,',
          click: send('menu:openSettings'),
        },
        { type: 'separator' },
        // Replaced `role: 'quit'` with an explicit click so we can
        // route through actuallyQuit(). The role variant calls
        // app.quit() directly, which is intercepted by the close
        // handler and bounces the window to the tray instead.
        {
          label: '終了',
          accelerator: 'CmdOrCtrl+Q',
          click: opts.onQuit,
        },
      ],
    },
    {
      label: '操作',
      submenu: [
        {
          label: '操作パネルを開く',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: send('menu:openOperations'),
        },
      ],
    },
    {
      // Top-level entry (not a submenu) so it surfaces directly in the
      // menu bar — matches the spec's request for prominence next to
      // ファイル / 操作.
      label: 'API 管理',
      accelerator: 'CmdOrCtrl+Shift+A',
      click: send('menu:openApiManagement'),
    },
    {
      // 段階 X1 — auto-record monitored creators screen. Top-level so
      // it sits as a peer to API 管理; this is the primary entry point
      // to the feature from the main window.
      label: '登録チャンネル',
      accelerator: 'CmdOrCtrl+Shift+M',
      click: send('menu:openMonitoredCreators'),
    },
    {
      // Temporary diagnostic submenu — for inspecting the
      // data-collection DB while debugging the "配信者 325 件" report.
      // Output goes to the terminal hosting `npm run dev` (main-process
      // console). Remove once the cause is fixed.
      label: 'デバッグ',
      submenu: [
        {
          label: 'DB 診断(データ収集)',
          click: () => {
            try {
              diagnoseDataCollection();
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn('[diag] menu click failed:', err);
            }
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
