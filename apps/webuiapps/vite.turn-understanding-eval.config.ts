import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/lib/aoiTurnUnderstandingEvalCliEntry.ts',
    outDir: 'dist-turn-understanding-eval',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiTurnUnderstandingEval.js',
      },
    },
  },
});
