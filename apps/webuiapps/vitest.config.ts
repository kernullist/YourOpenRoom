import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // Tests must never reach the network; stop happy-dom from auto-fetching
    // external resources (e.g. an embedded <iframe> src or widget scripts),
    // which otherwise emit abort noise during teardown.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableIframePageLoading: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
        },
      },
    },
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/lib/llmClient.ts'],
      thresholds: {
        lines: 75,
        functions: 85,
        branches: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@gui/vibe-container': resolve(__dirname, './src/lib/vibeContainerMock.ts'),
    },
  },
});
