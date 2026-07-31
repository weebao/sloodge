import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    // Node by default; component tests opt into happy-dom per file with a
    // `@vitest-environment happy-dom` docblock.
    environment: 'node',
  },
})
