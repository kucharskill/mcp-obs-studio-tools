import { readFileSync, appendFileSync } from 'node:fs';
import spawn from 'cross-spawn';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (process.argv[2] !== 'prepare' || tag !== `v${pkg.version}` || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Release tag must match a stable package version');
if (pkg.private === true || pkg.repository?.url !== 'git+https://github.com/kucharskill/mcp-obs-studio-tools.git' || process.env.GITHUB_REPOSITORY !== 'kucharskill/mcp-obs-studio-tools') throw new Error('Unexpected release destination');
const packed = spawn.sync('npm', ['pack', '--ignore-scripts', '--json'], { encoding: 'utf8' });
if (packed.status !== 0) throw new Error('npm pack failed');
const result = JSON.parse(packed.stdout);
const archive = Array.isArray(result) ? result[0] : Object.values(result)[0];
const checked = spawn.sync(process.execPath, ['scripts/verify-package.js', archive.filename], { stdio: 'inherit' });
if (checked.status !== 0) throw new Error('Archive verification failed');
const registered = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`);
if (registered.status !== 404 && !registered.ok) throw new Error(`Registry returned ${registered.status}`);
if (registered.ok && (await registered.json()).dist?.integrity !== archive.integrity) throw new Error('Registered version has different archive contents');
if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub Actions output path');
appendFileSync(process.env.GITHUB_OUTPUT, `archive=${archive.filename}\npublish=${registered.status === 404}\n`);
