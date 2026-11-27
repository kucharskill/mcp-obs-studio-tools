import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { after } from 'node:test';

// Keep test runtime caches isolated from real wrappers and other test processes.
const cacheRoot = resolve('.tmp', `test-discovery-${process.pid}`);
process.env.OBS_DISCOVERY_CACHE_DIR = cacheRoot;
after(() => rm(cacheRoot, { recursive: true, force: true }));

export async function tempDir(prefix) {
  const root = resolve('.tmp');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}
