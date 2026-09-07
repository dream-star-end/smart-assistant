import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: { input: resolve(import.meta.dirname, 'showroom.html') },
    emptyOutDir: true,
  },
})
