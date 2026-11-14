import { readFileSync } from 'node:fs';
export const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const serverInfo = { name: packageInfo.name, version: packageInfo.version };
