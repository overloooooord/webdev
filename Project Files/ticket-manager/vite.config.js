import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5200,
    proxy: {
      '/api': {
        target: 'http://localhost:3950',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3950',
        ws: true,
      },
    },
  },
});
