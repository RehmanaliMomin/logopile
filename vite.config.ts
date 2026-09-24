import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves the app from /<repo>/, local dev from /. The workflow
// sets VITE_BASE; everything else defaults to root.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  build: { target: 'es2022' },
  server: { port: 5188, open: true },
})
