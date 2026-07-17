import { defineConfig } from 'vite';

// Standalone build for the read-only field-evidence manifest CLI.
//
//   pnpm real-field:build  ->  dist-real-field-acceptance/aoiRealFieldAcceptance.js
//   pnpm real-field -- --sessions-dir /path/to/.openroom/sessions \
//     --session-path aoi/default --evidence-class live_field
export default defineConfig({
  build: {
    ssr: 'src/lib/aoiRealFieldAcceptanceCliEntry.ts',
    outDir: 'dist-real-field-acceptance',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiRealFieldAcceptance.js',
      },
    },
  },
});
