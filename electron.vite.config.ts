import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node24',
      rollupOptions: { external: ['electron'] },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node24',
      // sandbox: true preloads cannot be ES modules — emit CommonJS explicitly.
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    // root defaults to src/renderer, entry defaults to <root>/index.html
    plugins: [react(), tailwindcss()],
    build: {
      target: 'chrome150',
    },
  },
})
