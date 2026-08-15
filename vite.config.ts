/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': process.env.BENDIT_API_ORIGIN ?? 'http://localhost:8080',
    },
  },
  test: {
    environment: 'node',
    // Server-side logic (food normalization, search, importers) is plain ESM
    // under server/, tested with the same runner and style as the client libs.
    include: ['src/**/*.test.ts', 'server/**/*.test.mjs'],
    exclude: ['**/node_modules/**'],
  },
});
