import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { t } from 'tar';
import dotenv from 'dotenv';

const file = process.argv[2];
if (!file) throw new Error('Usage: npm run package:verify -- <archive.tgz>');
const allowed = /^(?:package\/(?:package\.json|README\.md|LICENSE|\.env\.example)|package\/src\/[\w/-]+\.js|package\/data\/(?:protocol\.json|OBS-WEBSOCKET-LICENSE))$/;
const localEnv = dotenv.parse(await readFile(new URL('../.env', import.meta.url), 'utf8').catch(() => ''));
const secrets = Object.entries(localEnv).filter(([key, value]) => /password|token|secret/i.test(key) && value.length >= 8).map(([, value]) => value);
/** @type {string[]} */
const files = [];
/** @type {string[]} */
const failures = [];
/** @type {Promise<void>[]} */
const reads = [];
await t({ file, onReadEntry: entry => {
  files.push(entry.path);
  if (!allowed.test(entry.path) || entry.path.split('/').includes('..') || entry.type !== 'File') failures.push(entry.path);
  reads.push(new Promise((resolve, reject) => {
    let text = '';
    entry.on('data', chunk => { text += chunk.toString('utf8'); });
    entry.on('error', reject);
    entry.on('end', () => {
      if (secrets.some(secret => text.includes(secret)) || /(?:[A-Z]:[\\/]Users[\\/]|E:[\\/]mpc[\\/])/i.test(text)) failures.push(entry.path);
      resolve();
    });
  }));
} });
await Promise.all(reads);
for (const required of ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/src/cli.js', 'package/src/worker.js', 'package/data/protocol.json']) if (!files.includes(required)) failures.push(required);
if (failures.length) throw new Error(`Package verification failed: ${[...new Set(failures)].join(', ')}`);
const bytes = await readFile(file);
console.log(JSON.stringify({ archive: file, files: files.length, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, allowlist: 'passed', localCredentialAndPathScan: 'passed' }));
