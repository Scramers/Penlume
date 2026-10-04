import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const rootDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.resolve(rootDirectory, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    minify: false,
    outDir: path.resolve(rootDirectory, 'dist/electron/preload'),
    rollupOptions: {
      external: ['electron'],
    },
    sourcemap: true,
  },
})
