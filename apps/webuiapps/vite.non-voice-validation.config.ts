import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/lib/aoiNonVoiceValidationCliEntry.ts',
    outDir: 'dist-non-voice-validation',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiNonVoiceValidation.js',
      },
    },
  },
});
