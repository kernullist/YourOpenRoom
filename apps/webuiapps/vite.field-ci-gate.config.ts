import { defineConfig } from 'vite';

// Standalone build for the Aoi field CI acceptance gate (P5.1).
//
// Like the daemon build, Node cannot execute .ts directly, so the CLI entry is bundled
// to a single Node-runnable ESM file via the toolchain already in the tree (no new
// dependency). Server-only imports (child_process for git) are safe here because this is
// a SEPARATE build target from the client bundle -- it never reaches the browser.
//
//   pnpm field-ci:build  ->  dist-field-ci-gate/aoiFieldCiGate.js
//   pnpm field-ci -- --base origin/main
export default defineConfig({
  build: {
    ssr: 'src/lib/aoiFieldCiGateCliEntry.ts',
    outDir: 'dist-field-ci-gate',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiFieldCiGate.js',
      },
    },
  },
});
