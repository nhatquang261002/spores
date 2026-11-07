import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { runsPlugin } from './server/runs.ts';
import { siteMetaPlugin } from './server/siteMeta.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The hiring rule is shared with the agents (no second implementation in JS):
// `@rules` is agents/src/rules.ts, which has no imports. The dev server may
// read only viz/ and that one file; run logs come through /runs/ (server/runs.ts).
export default defineConfig({
  plugins: [react(), runsPlugin(here('../out/agents')), siteMetaPlugin()],
  resolve: {
    alias: { '@rules': here('../agents/src/rules.ts') },
  },
  server: {
    host: '127.0.0.1',
    fs: { strict: true, allow: [here('.'), here('../agents/src/rules.ts')] },
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
