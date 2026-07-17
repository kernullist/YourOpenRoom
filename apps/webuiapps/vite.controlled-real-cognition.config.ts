import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/lib/aoiControlledRealCognitionEvidenceCliEntry.ts',
    outDir: 'dist-controlled-real-cognition',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiControlledRealCognitionEvidence.js',
      },
    },
  },
});
