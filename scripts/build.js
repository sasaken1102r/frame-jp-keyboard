// Bundles src/ into dist/bundle.js: one IIFE that is evaluated in Steam's SharedJSContext over CDP.
import { readFile, writeFile } from 'node:fs/promises';
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

// The injector (plain Python, no build step) reads its own version from this sibling file to pass
// as frame-update.sh's --current; see injector/frame_jp_keyboard_injector.py and scripts/package.js.
await writeFile(new URL('../dist/VERSION', import.meta.url), `${pkg.version}\n`);
