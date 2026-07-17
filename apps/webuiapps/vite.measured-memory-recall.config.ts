import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/lib/aoiMeasuredMemoryRecallCliEntry.ts',
    outDir: 'dist-measured-memory-recall',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiMeasuredMemoryRecall.js',
      },
    },
  },
});
