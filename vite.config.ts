import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }
          if (id.includes('@supabase')) {
            return 'supabase'
          }
          if (id.includes('react')) {
            return 'react-vendor'
          }
          if (id.includes('tailwindcss')) {
            return 'tailwind-vendor'
          }
          return 'vendor'
        },
      },
    },
  },
})
