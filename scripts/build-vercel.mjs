// Produces a Vercel Build Output API v3 bundle in .vercel/output:
//   static/                 the built React app (from dist/web)
//   functions/api.func/     one Node.js function serving every /api/* route
//   config.json             routing: /api/* → function, files → static, everything else → index.html
// Run after `npm run build` (the npm script build:vercel does both).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const out = '.vercel/output';
if (!existsSync('dist/web/index.html')) throw new Error('dist/web is missing — run `npm run build` first');
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/functions/api.func`, { recursive: true });
cpSync('dist/web', `${out}/static`, { recursive: true });

await build({
  entryPoints: ['server/vercel.ts'],
  outfile: `${out}/functions/api.func/index.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // node:sqlite is only used for local files; the libSQL HTTP client is pure JS.
  external: ['node:sqlite'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

writeFileSync(
  `${out}/functions/api.func/.vc-config.json`,
  JSON.stringify(
    { runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 30 },
    null,
    2,
  ),
);

writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/api/(.*)$', dest: '/api?__p=$1' },
        {
          src: '^/assets/(.*)$',
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          continue: true,
        },
        {
          src: '^/(sw\\.js|manifest\\.webmanifest)$',
          headers: { 'Cache-Control': 'no-cache' },
          continue: true,
        },
        { handle: 'filesystem' },
        { src: '^/(.*)$', dest: '/index.html', headers: { 'Cache-Control': 'no-cache' } },
      ],
    },
    null,
    2,
  ),
);
console.log('Vercel output written to .vercel/output');
