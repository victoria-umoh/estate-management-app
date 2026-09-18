import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Integration tests spin up an in-memory MongoDB replica set; give them room.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/core/**', 'src/modules/**', 'src/integrations/**'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
    },
  },
});
