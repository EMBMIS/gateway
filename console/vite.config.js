import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The console is served by the gateway, at "/" or under a path of a shared host (CONSOLE_BASE=/gateway/ in the Docker build).
export default defineConfig({
  base: process.env.CONSOLE_BASE || '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/health': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const m = id.replace(/\\/g, '/').match(/node_modules\/(?:(@[^/]+)\/)?([^/]+)/)
          if (!m) return undefined
          const pkg = m[1] ? `${m[1]}/${m[2]}` : m[2]
          if (['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler', 'clsx'].includes(pkg)) return 'vendor-react'
          if (pkg === '@heroicons/react') return 'vendor-icons'
          return undefined
        },
      },
    },
  },
})
