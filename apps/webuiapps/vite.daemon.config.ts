import { defineConfig } from 'vite';

// Standalone build for the headless autonomy daemon (P0a).
//
// Node 20 cannot execute .ts directly, so the daemon is bundled to a single
// Node-runnable ESM file via the toolchain already in the tree (no new
// dependency). This is a SEPARATE build target from the client bundle, which
// is precisely why server-only code (http/fs/dns/process) is safe here: it
// never reaches the browser bundle.
//
//   pnpm daemon:build   ->  dist-daemon/aoiDaemonServer.js
//   pnpm daemon         ->  node dist-daemon/aoiDaemonServer.js
export default defineConfig({
  build: {
    ssr: 'src/lib/aoiDaemonServer.ts',
    outDir: 'dist-daemon',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiDaemonServer.js',
      },
    },
  },
});
