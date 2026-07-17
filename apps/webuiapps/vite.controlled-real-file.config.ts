import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/lib/aoiControlledRealFileEvidenceCliEntry.ts',
    outDir: 'dist-controlled-real-file',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiControlledRealFileEvidence.js',
      },
    },
  },
});
