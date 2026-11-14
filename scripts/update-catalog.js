import { writeFile } from 'node:fs/promises';

const repo = 'https://api.github.com/repos/obsproject/obs-websocket/commits/master';
const revisionResponse = await fetch(repo, { signal: AbortSignal.timeout(30000) });
if (!revisionResponse.ok) throw new Error(`GitHub returned ${revisionResponse.status}`);
const { sha } = await revisionResponse.json();
const source = `https://raw.githubusercontent.com/obsproject/obs-websocket/${sha}/docs/generated/protocol.json`;
const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Protocol download returned ${response.status}`);
const { requests } = await response.json();
if (!Array.isArray(requests) || !requests.some(item => item.requestType === 'GetVersion')) throw new Error('Invalid protocol catalog');
await writeFile(new URL('../data/protocol.json', import.meta.url), JSON.stringify({ source, revision: sha, requests }, null, 2) + '\n');
console.log(`Updated ${requests.length} commands at ${sha}`);
