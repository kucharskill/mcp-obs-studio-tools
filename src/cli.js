#!/usr/bin/env node
import { packageInfo } from './package.js';
import { applyEnvFileOption, loadEnvironment } from './config.js';

const startupEnv = { ...process.env };
const startedAt = new Date().toISOString();

const usage = 'obs-mcp [--env-file PATH | -env_file PATH] [mcp | --tool-manifest | --execute-tool NAME | --version | --help]';
try {
  const args = applyEnvFileOption(process.argv.slice(2));
  if (!args.length || (args.length === 1 && args[0] === 'mcp')) {
    const { writeEnvironmentSnapshot } = await import('./discovery-store.js');
    writeEnvironmentSnapshot(loadEnvironment().OBS_DISCOVERY_CACHE_DIR, startupEnv, startedAt);
    const [{ serveStdio }, { createAdapter }, { createRunner }] = await Promise.all([
      import('@modelcontextprotocol/server/stdio'), import('./adapter.js'), import('./runner.js'),
    ]);
    const run = createRunner(packageInfo.name);
    const handle = serveStdio(() => createAdapter(run));
    const close = () => { void Promise.allSettled([handle.close(), run.close()]); };
    process.stdin.once('end', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } else if (args.length === 1 && args[0] === '--worker') {
    const { startWorker } = await import('./worker.js');
    startWorker();
  } else if (args.length === 1 && args[0] === '--tool-manifest') {
    const { manifest } = await import('./tools.js');
    console.log(JSON.stringify(manifest()));
  } else if (args.length === 2 && args[0] === '--execute-tool') {
    const { executeTool } = await import('./tools.js');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('CLI arguments exceeded 1 MiB');
    }
    console.log(JSON.stringify(await executeTool(args[1], JSON.parse(input))));
  } else if (args.length === 1 && args[0] === '--version') console.log(packageInfo.version);
  else if (args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(usage);
  else throw new Error(usage);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
