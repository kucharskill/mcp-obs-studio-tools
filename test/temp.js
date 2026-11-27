import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export async function tempDir(prefix) {
  const root = resolve('.tmp');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}
