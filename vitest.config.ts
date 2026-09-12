import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      [
        'contracts',
        'storage',
        'providers',
        'context',
        'tools',
        'local-runtime',
        'skills',
        'mcp',
      ].map((name) => [
        '@lodex/' + name,
        fileURLToPath(new URL('./packages/' + name + '/src/index.ts', import.meta.url)),
      ]),
    ),
  },
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/daemon/**/*.test.ts',
      'apps/desktop/**/*.test.{ts,tsx}',
    ],
    testTimeout: 15000,
    hookTimeout: 20000,
  },
});
