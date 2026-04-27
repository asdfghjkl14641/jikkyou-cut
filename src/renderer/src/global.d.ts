import type { IpcApi } from '../../common/types';

declare global {
  interface Window {
    api: IpcApi;
  }
}

export {};
