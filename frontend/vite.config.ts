import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/health': 'http://localhost:8100',
      '/v1': 'http://localhost:8100',
    },
  },
  test: {
    // Vitest's default `include` is `**/*.{test,spec}.*` with no directory limit,
    // so it would collect the Playwright specs in `e2e/` and fail on Playwright's
    // `test()`. `exclude` REPLACES the defaults rather than extending them, hence
    // spreading `configDefaults.exclude` — dropping it would send vitest into
    // `node_modules`.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
