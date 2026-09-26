// Bundles src/ into dist/bundle.js: one IIFE that is evaluated in Steam's SharedJSContext over CDP.
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'chrome126',
  outfile: 'dist/bundle.js',
  charset: 'utf8',
  // Keep /*! ... */ notices (the English word list's copyright notice) in the bundle.
  legalComments: 'inline',
  define: { __FJK_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: `/*! frame-jp-keyboard ${pkg.version} | MIT License | word list: see THIRD_PARTY_LICENSES.md */` },
  logLevel: 'info',
});
