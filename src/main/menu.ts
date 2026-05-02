import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

export function buildMenu(getMainWindow: () => BrowserWindow | null) {
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
        { role: 'quit', label: '終了' },
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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
