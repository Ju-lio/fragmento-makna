import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Duas entradas, não um router: o editor e o /criar não compartilham
    // estado, e um router traria dependência e um bundle único pra servir
    // duas páginas que ninguém usa ao mesmo tempo. Ver `criar.html`.
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        criar: resolve(import.meta.dirname, 'criar.html'),
      },
    },
  },
})
