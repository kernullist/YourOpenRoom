import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/lib/aoiUserAuthorizedPlanCliEntry.ts',
    outDir: 'dist-user-authorized-plan',
    target: 'node20',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'aoiUserAuthorizedPlan.js',
      },
    },
  },
});
