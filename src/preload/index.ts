import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('api', {
  appName: 'jikkyou-cut',
});
