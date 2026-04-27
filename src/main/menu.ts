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
    { role: 'editMenu', label: '編集' },
    { role: 'viewMenu', label: '表示' },
    { role: 'windowMenu', label: 'ウィンドウ' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
