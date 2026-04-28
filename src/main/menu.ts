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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
