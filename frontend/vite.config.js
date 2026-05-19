import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND_TARGET = process.env.VITE_BACKEND || 'http://localhost:80'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND_TARGET, changeOrigin: true },
      '/ws': { target: BACKEND_TARGET, changeOrigin: true, ws: true },
    },
  },
})
