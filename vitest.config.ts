import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@mcvis/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@mcvis/formats': path.resolve(__dirname, 'packages/formats/src/index.ts'),
      '@mcvis/mod-loader': path.resolve(__dirname, 'packages/mod-loader/src/index.ts'),
      '@mcvis/importers': path.resolve(__dirname, 'packages/importers/src/index.ts'),
      '@mcvis/renderer': path.resolve(__dirname, 'packages/renderer/src/index.ts'),
      '@mcvis/ui': path.resolve(__dirname, 'packages/ui/src/index.ts')
    }
  },
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node'
  }
});
