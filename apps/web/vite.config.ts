import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Measure gzip separately when profiling; skipping it keeps normal builds faster.
    reportCompressedSize: false,
  },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], environment: 'node' },
});
