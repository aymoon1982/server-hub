import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const rawBackend = process.env.VITE_BACKEND || 'http://localhost:80';
const allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(rawBackend);
const BACKEND_TARGET = allowed ? rawBackend : 'http://localhost:80';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 5173,
    proxy: {
      '/api': { target: BACKEND_TARGET, changeOrigin: true },
      '/ws': { target: BACKEND_TARGET, changeOrigin: true, ws: true },
    },
  },
})
