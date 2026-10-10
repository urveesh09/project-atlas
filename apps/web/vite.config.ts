import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const packages = fileURLToPath(new URL('../../packages/', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The viewer bundles shared packages from source; it never imports analyzer or ingest code.
    alias: [{ find: /^@atlas\/(schema|layout|graph|artifact)$/, replacement: `${packages}$1/src/index.ts` }],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        spike: fileURLToPath(new URL('./spike.html', import.meta.url)),
      },
    },
  },
  server: { host: '127.0.0.1', strictPort: true, port: 4317 },
  preview: { host: '127.0.0.1' },
});
