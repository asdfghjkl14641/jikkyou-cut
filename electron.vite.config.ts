import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node22',
      sourcemap: true,
      // Belt-and-braces against the 2026-05-02 build-cache bug where
      // better-sqlite3 (and its native loader `bindings`) ended up
      // partially bundled, causing rollup-commonjs to emit a runtime
      // stub that threw
      //   Could not dynamically require "<root>/build/better_sqlite3.node"
      // on every batch. `externalizeDepsPlugin` already covers top-
      // level deps from package.json, but `bindings` is a transitive
      // dep so we pin it explicitly here too. Also keeping the
      // top-level dep pinned prevents accidental regressions if the
      // plugin is ever swapped out.
      rollupOptions: {
        external: ['better-sqlite3', 'bindings'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
