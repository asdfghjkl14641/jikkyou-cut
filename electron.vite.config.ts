import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      target: 'node22',
      sourcemap: true,
    },
  },
  preload: {
    build: {
      target: 'node22',
      sourcemap: true,
      rollupOptions: {
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      target: 'chrome130',
      sourcemap: true,
    },
    server: {
      port: 3001,
      host: '127.0.0.1',
    },
  },
});
