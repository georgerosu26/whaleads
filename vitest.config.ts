import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  // `cloudflare:workers` only exists inside workerd; unit tests get a stub (the real runtime is covered by the e2e).
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
