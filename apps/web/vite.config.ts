import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const backendOrigin = new URL(process.env.PODCASTER_BACKEND_ORIGIN ?? 'http://127.0.0.1:43127').origin;
const backendProxy = { target: backendOrigin, changeOrigin: true, headers: { origin: backendOrigin } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PODCASTER_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': backendProxy,
      '/ws': { ...backendProxy, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Measure gzip separately when profiling; skipping it keeps normal builds faster.
    reportCompressedSize: false,
  },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], environment: 'node' },
});
