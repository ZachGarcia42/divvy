import { defineConfig } from 'vitest/config'

// The in-memory Postgres (PGlite) tests are slow when the machine is busy (several suites at once): a longer limit stops those flaking.
export default defineConfig({ test: { testTimeout: 30000, hookTimeout: 60000 } })
