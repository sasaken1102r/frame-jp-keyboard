// Builds a release archive: dist/frame-jp-keyboard-<version>.tar.gz containing a frame-jp-keyboard/
// folder with the prebuilt bundle, the injector, the service unit, install.sh and the notices.
// install.sh accepts this flat layout, so users only extract it on the headset and run ./install.sh.
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const name = `frame-jp-keyboard-${pkg.version}`;

/** Files shipped in the archive, relative to the repository root. */
const FILES = [
  'dist/bundle.js',
  'injector/frame_jp_keyboard_injector.py',
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
 * Test, build and pack the release archive.
 * @returns {Promise<string>} Path of the archive, relative to the repository root
 * @example
 * await makePackage() // "dist/frame-jp-keyboard-0.5.1.tar.gz"
 */
const makePackage = async () => {
  run('npm', ['test']);
  run('npm', ['run', 'build']);
  const stage = await mkdtemp(join(tmpdir(), 'fjk-package-'));
  try {
    const folder = join(stage, 'frame-jp-keyboard');
    await mkdir(folder);
    for (const file of FILES) await copyFile(repoPath(file), join(folder, basename(file)));
    await chmod(join(folder, 'install.sh'), 0o755);
    await chmod(join(folder, 'frame_jp_keyboard_injector.py'), 0o755);
    const archive = `dist/${name}.tar.gz`;
    // Windows' bundled bsdtar and GNU tar both accept these options; -C keeps the paths relative.
    // The archive path stays relative: GNU tar reads "U:\..." in -f as a remote host "U".
    // Don't record the builder's user and group names in the archive.
    const gnu = execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('GNU');
    const owner = gnu ? ['--owner=0', '--group=0', '--numeric-owner'] : ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root'];
    execFileSync('tar', [...owner, '-czf', archive, '-C', stage, 'frame-jp-keyboard'], { cwd: repoPath('.'), stdio: 'inherit' });
    return archive;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

console.log(await makePackage());
