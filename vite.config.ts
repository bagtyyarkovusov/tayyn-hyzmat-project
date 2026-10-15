import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
export default defineConfig({ plugins: [vue(), tailwindcss()], resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }, envPrefix: ['VITE_', 'VUE_APP_'], build: { rollupOptions: { input: { index: fileURLToPath(new URL('./index.html', import.meta.url)), driver: fileURLToPath(new URL('./driver.html', import.meta.url)) } } }, server: { port: 5185, strictPort: true, proxy: { '/api': { target: process.env.TAYYN_TEST_API || 'http://127.0.0.1:4185', rewrite: p => p.replace(/^\/api/, '') }, '/socket.io': { target: process.env.TAYYN_TEST_API || 'http://127.0.0.1:4185', ws: true } } } })
