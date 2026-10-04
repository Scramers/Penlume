import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export default defineConfig({
  base: './',
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  plugins: [react()],
  resolve: {
    // The package's browser export touches document at module initialization.
    // Its default export uses the same entity table and also runs in workers.
    alias: { 'decode-named-character-reference': require.resolve('decode-named-character-reference') },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
})
