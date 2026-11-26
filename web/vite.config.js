import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// En desarrollo, la API la atiende el gateway en :8080.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true, changeOrigin: false },
      '/salud': 'http://localhost:8080',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
