// Builds a release archive: dist/frame-jp-keyboard-<version>.tar.gz containing a frame-jp-keyboard/
// folder with the prebuilt bundle, the injector, the service unit, install.sh and the notices.
// install.sh accepts this flat layout, so users only extract it on the headset and run ./install.sh.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const name = `frame-jp-keyboard-${pkg.version}`;

/** Files shipped in the archive, relative to the repository root. */
const FILES = [
  'dist/bundle.js',
  'dist/VERSION',
  'injector/frame_jp_keyboard_injector.py',
  'vendor/frame-updater/frame-update.sh',
  'vendor/frame-updater/python/frame_update.py',
  'contrib/frame-jp-keyboard.service',
  'install.sh',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_LICENSES.md',
];

/**
 * Resolve a repository-relative path to a filesystem path.
 * @param {string} relative - Path relative to the repository root
 * @returns {string} Absolute filesystem path
 * @example
 * repoPath('dist/bundle.js')
 */
const repoPath = (relative) => fileURLToPath(new URL(relative, root));

/**
 * Run a command with inherited output, throwing on failure.
 * @param {string} command - Executable
 * @param {string[]} args - Arguments
 * @returns {void}
 * @example
 * run('npm', ['test'])
 */
const run = (command, args) => {
  // npm is a .cmd shim on Windows, which needs a shell. Pass one command string (no args array) so
  // Node doesn't warn about unescaped shell arguments (DEP0190); the arguments here are fixed words.
  if (process.platform === 'win32') execFileSync([command, ...args].join(' '), { cwd: repoPath('.'), stdio: 'inherit', shell: true });
  else execFileSync(command, args, { cwd: repoPath('.'), stdio: 'inherit' });
};

/**
 * SHA-256 of a file with CR removed (matches how frame-updater's sync.sh hashed it into
 * MANIFEST.sha256, so a CRLF checkout on Windows still verifies; see frame-updater's README.md).
 * @param {string} path - File path
 * @returns {Promise<string>} Lowercase hex digest
 * @example
 * await hashNoCr(repoPath('vendor/frame-updater/frame-update.sh'))
 */
const hashNoCr = async (path) => createHash('sha256').update((await readFile(path)).toString('latin1').replace(/\r/g, ''), 'latin1').digest('hex');

/**
 * Check the vendored frame-updater copy against its own MANIFEST.sha256 (sync.sh writes both),
 * so a hand-edited or out-of-sync copy fails the build instead of shipping quietly.
 * @returns {Promise<void>} Resolves if every listed file's hash matches
 * @example
 * await verifyVendor()
 */
const verifyVendor = async () => {
  const manifest = await readFile(repoPath('vendor/frame-updater/MANIFEST.sha256'), 'utf8');
  for (const line of manifest.split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!match) continue;
    const [, expected, relative] = match;
    const path = repoPath(`vendor/frame-updater/${relative}`);
    const actual = await hashNoCr(path);
    if (actual !== expected) {
      throw new Error(`vendor/frame-updater/${relative} does not match MANIFEST.sha256 (edited by hand? re-run sync.sh)`);
    }
  }
};

/**
 * Test, build and pack the release archive.
 * @returns {Promise<string>} Path of the archive, relative to the repository root
 * @example
 * await makePackage() // "dist/frame-jp-keyboard-0.5.1.tar.gz"
 */
const makePackage = async () => {
  await verifyVendor();
  run('npm', ['test']);
  run('npm', ['run', 'build']);
  const stage = await mkdtemp(join(tmpdir(), 'fjk-package-'));
  try {
    const folder = join(stage, 'frame-jp-keyboard');
    await mkdir(folder);
    for (const file of FILES) await copyFile(repoPath(file), join(folder, basename(file)));
    await chmod(join(folder, 'install.sh'), 0o755);
    await chmod(join(folder, 'frame_jp_keyboard_injector.py'), 0o755);
    await chmod(join(folder, 'frame-update.sh'), 0o755);
    const archive = `dist/${name}.tar.gz`;
    // Windows' bundled bsdtar and GNU tar both accept these options; -C keeps the paths relative.
    // The archive path stays relative: GNU tar reads "U:\..." in -f as a remote host "U".
    // Don't record the builder's user and group names in the archive.
    const gnu = execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('GNU');
    const owner = gnu ? ['--owner=0', '--group=0', '--numeric-owner'] : ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root'];
    execFileSync('tar', [...owner, '-czf', archive, '-C', stage, 'frame-jp-keyboard'], { cwd: repoPath('.'), stdio: 'inherit' });
    const archiveHash = createHash('sha256').update(await readFile(repoPath(archive))).digest('hex');
    await writeFile(repoPath('dist/SHA256SUMS'), `${archiveHash}  ${basename(archive)}\n`);
    return archive;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

const archive = await makePackage();
console.log(archive);
console.log('dist/SHA256SUMS');
