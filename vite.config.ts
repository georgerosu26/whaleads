import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'ui/src') } },
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8787', '/webhooks': 'http://localhost:8787' } },
})
