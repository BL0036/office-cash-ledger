import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// `base` is the URL path the built app is served from.
//   - Firebase Hosting / local use  -> '/'            (default, unchanged behaviour)
//   - GitHub Pages project site     -> '/<repo-name>/' (set by the GitHub Actions
//                                       workflow through the VITE_BASE variable)
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
})
