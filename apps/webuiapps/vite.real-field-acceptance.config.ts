import { defineConfig } from 'vite';

// Standalone build for the real-ledger field-operations acceptance CLI (P5.1).
//
// Like the daemon and field-CI-gate builds, Node cannot execute .ts directly, so the CLI
// entry is bundled to a single Node-runnable ESM file via the toolchain already in the
// tree (no new dependency). Server-only imports (fs/path via the pack) are safe here
// because this is a SEPARATE build target from the client bundle.
//
//   pnpm real-field:build  ->  dist-real-field-acceptance/aoiRealFieldAcceptance.js
//   pnpm real-field -- --sessions-dir /path/to/.openroom/sessions
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
