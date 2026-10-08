import { build } from 'esbuild';
import { preparePty } from './prepare-pty.mjs';
import { prepareBrowser } from './prepare-browser.mjs';
await build({
  entryPoints: {
    main: 'apps/daemon/src/main.ts',
    worker: 'packages/storage/src/worker.ts',
    supervisor: 'packages/local-runtime/src/supervisor.ts',
    'mcp-supervisor': 'packages/mcp/src/supervisor.ts',
    'pty-supervisor': 'packages/tools/src/pty-supervisor.ts',
    'lsp-supervisor': 'apps/daemon/src/lsp-supervisor.ts',
  },
  bundle: true,
  platform: 'node',
  // jsonc-parser's UMD entry passes require through a factory, hiding relative
  // imports from the bundler. Its ESM entry keeps packaged daemons self-contained.
  alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
  target: 'node24',
  format: 'cjs',
  outdir: 'apps/daemon/dist',
  outExtension: { '.js': '.cjs' },
  sourcemap: true,
  external: ['node:*', 'node-pty', 'playwright-core'],
  logLevel: 'info',
});
await preparePty();
await prepareBrowser();
