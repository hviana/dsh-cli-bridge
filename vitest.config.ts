import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    // Every suite is hermetic: the domain is pure and the runtime is driven
    // through injected ports, so nothing here reaches a network or a real CLI.
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/client/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
