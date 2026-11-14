import { existsSync, readFileSync } from 'node:fs';
import spawn from 'cross-spawn';

/** @param {string} command @param {string[]} args @param {boolean} [capture] */
function run(command, args, capture = false) {
  const result = spawn.sync(command, args, { encoding: 'utf8', windowsHide: true, stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${command} failed (${result.status})`);
  return result.stdout?.trim() ?? '';
}

try {
  const mode = process.argv[2];
  if (!['prepare', 'publish'].includes(mode)) throw new Error('Usage: node scripts/publish-commit.js prepare|publish');
  if (run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], true) === 'main') {
    const pkg = JSON.parse(mode === 'prepare' ? readFileSync('package.json', 'utf8') : run('git', ['show', 'HEAD:package.json'], true));
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Automatic latest releases require a stable version');
    if (mode === 'prepare') {
      if (run('git', ['diff', '--name-only', '--', 'package.json', 'package-lock.json'], true)) throw new Error('Stage package metadata before committing');
      const previous = JSON.parse(run('git', ['show', 'HEAD:package.json'], true));
      if (pkg.version === previous.version) run('npm', ['version', 'patch', '--no-git-tag-version', '--ignore-scripts']);
      run('git', ['add', 'package.json', ...(existsSync('package-lock.json') ? ['package-lock.json'] : [])]);
    } else {
      const tag = `v${pkg.version}`, head = run('git', ['rev-parse', 'HEAD'], true);
      const existing = spawn.sync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' });
      if (existing.status === 0 && existing.stdout.trim() !== head) throw new Error(`${tag} already belongs to another commit`);
      if (existing.status !== 0) run('git', ['tag', tag, head]);
      run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=manager', 'push', '--atomic', '--set-upstream', 'origin', 'HEAD', `refs/tags/${tag}`]);
      console.error(`Pushed ${tag}; GitHub Actions will publish npm and the GitHub Release.`);
    }
  }
} catch (error) {
  console.error(`Automatic publication: ${error instanceof Error ? error.message : String(error)}. The local commit remains available.`);
  process.exitCode = 1;
}
