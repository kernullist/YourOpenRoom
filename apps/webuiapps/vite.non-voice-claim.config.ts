import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/lib/aoiNonVoiceClaimCliEntry.ts',
    outDir: 'dist-non-voice-claim',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiNonVoiceClaim.js',
      },
    },
  },
});
