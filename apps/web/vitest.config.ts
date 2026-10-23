import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Node 25+ turns on its own Web Storage global by default, which shadows
// jsdom's localStorage/sessionStorage in the workers (#352). Node 20 has no
// such flag and refuses to start with it, hence the feature check.
const nodeWebStorageOff = process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
  ? ['--no-experimental-webstorage']
  : []

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
    css: false,
    execArgv: nodeWebStorageOff,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
