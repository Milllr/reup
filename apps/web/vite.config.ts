/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The hub serves the built app from apps/web/dist. In dev, open with ?hub=http://localhost:3000 or ?mock=1.
export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.PORT) || 5173, strictPort: false },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], css: false },
});
