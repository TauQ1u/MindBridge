import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [vue(), react()],
  build: {
    // 不产出 sourcemap，避免源码经构建产物外泄
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@neuron3d': fileURLToPath(new URL('./src/modules/neuron3d/core', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/data': 'http://127.0.0.1:3001',
    },
  },
})
