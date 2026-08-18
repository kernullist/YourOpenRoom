import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/lib/aoiAppActionClaimSweepCliEntry.ts',
    outDir: 'dist-claim-sweep',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiClaimSweep.js',
      },
    },
  },
});
