import { tempDir } from './temp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile, readFile, utimes, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { runnerMode, createRunner } from '../src/runner.js';
import { findCommands, validateCommand } from '../src/catalog.js';
import { rememberRecording, lastRecording } from '../src/history.js';
import spawn from 'cross-spawn';
import { launch, findExecutable } from '../src/launch.js';
import { findObsProcesses } from '../src/processes.js';
import { applyEnvFileOption, saveExecutable } from '../src/config.js';
import dotenv from 'dotenv';
import { connectionFailure } from '../src/obs.js';

test('connection refusal includes actionable server activation guidance', () => {
  const failure = connectionFailure(new Error('connect ECONNREFUSED 127.0.0.1:4455'), false);
  assert.equal(failure.errorCode, 'OBS_WEBSOCKET_UNAVAILABLE');
  assert.match(failure.userAction, /Ask the user/);
  assert.match(failure.userAction, /Tools > WebSocket Server Settings/);
});

test('env-file aliases resolve paths and persist discovered executables without losing configuration', async () => {
  const root = await tempDir('obs-env-test-');
  try {
    const path = join(root, 'settings.env');
    const env = {};
    assert.deepEqual(applyEnvFileOption(['mcp', '-env_file', path], env), ['mcp']);
    assert.equal(env.OBS_ENV_FILE, path);
    assert.deepEqual(applyEnvFileOption([`--env-file=${path}`, '--version'], env), ['--version']);
    assert.throws(() => applyEnvFileOption(['--env-file'], {}));
    const original = '# preserve this comment\r\nOBS_PASSWORD="multiline\nsecret"\r\nOBS_EXECUTABLE=old-path\r\n';
    await writeFile(path, original);
    const executable = process.execPath;
    await Promise.all([saveExecutable(executable, env), saveExecutable(executable, env)]);
    const updated = await readFile(path, 'utf8');
    assert.ok(updated.startsWith(original));
    assert.equal(dotenv.parse(updated).OBS_EXECUTABLE, executable);
    assert.equal(dotenv.parse(updated).OBS_PASSWORD, 'multiline\nsecret');
    assert.equal((await saveExecutable(executable, env)).saved, false);
    const found = await findExecutable(executable, env, async () => ({ processes: [], processScanError: null }));
    assert.equal(found.source, 'configured');
    assert.deepEqual(found.checkedPaths, [executable]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('running OBS path is validated and prevents gathering installation or PATH candidates', async () => {
  const root = await tempDir('obs-process-env-test-');
  try {
  const processes = await findObsProcesses(async () => ({ list: [
    { pid: 1, name: 'obs64.exe', path: process.execPath },
    { pid: 2, name: 'obs32.exe', path: join(process.cwd(), 'missing-obs.exe') },
    { pid: 3, name: 'obs-browser-page.exe', path: process.execPath },
  ] }));
  assert.equal(processes.processes.length, 2);
  assert.equal(processes.processes[1].executable, null);
  const env = new Proxy({}, { get: (_target, key) => { if (key === 'OBS_ENV_FILE') return join(root, '.env'); throw new Error('Fallback paths must not be gathered'); }, ownKeys: () => { throw new Error('PATH must not be gathered'); } });
  const found = await findExecutable(join(root, 'lower-priority.exe'), env, async () => processes);
  assert.equal(found.source, 'running-process');
  assert.equal(found.executable, process.execPath);
  assert.deepEqual(found.checkedPaths, [process.execPath]);
  assert.equal(found.persistence.saved, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unusable process paths fall back to validated PATH candidates, reporting process scan errors', async () => {
  const root = await tempDir('obs-discovery-test-');
  try {
    const binary = join(root, process.platform === 'win32' ? 'obs64.exe' : 'obs');
    await writeFile(binary, 'fixture'); await chmod(binary, 0o755);
    const observed = { processes: [{ pid: 1, name: 'obs64.exe', executable: join(root, 'missing.exe'), architecture: null }], processScanError: null };
    const found = await findExecutable(undefined, { OBS_ENV_FILE: join(root, '.env'), PATH: root, ProgramFiles: root, 'ProgramFiles(x86)': root }, async () => observed);
    // Unix may have an actual OBS in a standard folder, which also satisfies discovery.
    assert.ok(found.executable);
    assert.ok(found.checkedPaths.includes(observed.processes[0].executable));
    if (found.source === 'PATH') assert.equal(found.executable, binary);
    const failed = await findObsProcesses(async () => { throw new Error('Process access denied'); });
    assert.deepEqual(failed.processes, []);
    assert.equal(failed.processScanError, 'Process access denied');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual npx execution metadata selects latest mode without a network lookup', () => {
  const env = { ...process.env };
  delete env.OBS_MCP_RUNNER;
  const result = spawn.sync('npx', ['--offline', '-c', 'node test/runner-probe.js'], { encoding: 'utf8', env, windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).mode, 'latest');
});

test('launch spawns an executable without requiring WebSocket or invoking a shell', async () => {
  const result = await launch({ executable: process.execPath, args: ['--eval', 'process.exit(0)'] });
  assert.equal(result.launched, true);
  assert.equal(result.websocketChecked, false);
  await assert.rejects(launch({ executable: 'relative-obs.exe' }), /absolute/);
});

test('runner detects npm exec, direct execution and npm scripts, with explicit override', () => {
  assert.equal(runnerMode({}), 'local');
  assert.equal(runnerMode({ npm_command: 'exec', npm_lifecycle_event: 'npx' }), 'latest');
  assert.equal(runnerMode({ npm_command: 'run-script', npm_lifecycle_event: 'start' }), 'local');
  assert.equal(runnerMode({ npm_command: 'exec', npm_lifecycle_event: 'start' }), 'local');
  assert.equal(runnerMode({ OBS_MCP_RUNNER: 'local', npm_command: 'exec', npm_lifecycle_event: 'npx' }), 'local');
  assert.equal(runnerMode({ OBS_MCP_RUNNER: 'latest' }), 'latest');
  assert.throws(() => runnerMode({ OBS_MCP_RUNNER: 'invalid' }));
});

test('installed local CLI produces manifest and executes a tool through a child process', async () => {
  const run = createRunner('not-published-do-not-fetch', { ...process.env, OBS_MCP_RUNNER: 'local' });
  try {
  const manifest = await run(['--tool-manifest']);
  assert.equal(manifest.tools.length, 11);
  const result = await run(['--execute-tool', 'obs_commands'], { name: 'StartRecord' });
  assert.equal(JSON.parse(result.content[0].text).command.requestType, 'StartRecord');
  const invalid = await run(['--execute-tool', 'obs_execute'], { requests: [{ requestType: 'StartRecord', requestData: { invalid: true } }] });
  assert.equal(invalid.isError, true);
  } finally { await run.close(); }
});

test('catalog searches and validates full sequences before connecting', () => {
  assert.ok(findCommands({ query: 'record', limit: 50 }).total > 5);
  assert.equal(findCommands({ name: 'GetSourceScreenshot' }).command.requestType, 'GetSourceScreenshot');
  assert.throws(() => validateCommand('Missing', {}));
  assert.throws(() => validateCommand('SetCurrentProgramScene', { unknown: true }));
  assert.throws(() => validateCommand('SetInputMute', { inputMuted: 'yes' }));
});

test('recording history expires at 12h and discovers local files with honest timestamps', async () => {
  const root = await tempDir('obs-history-test-');
  try {
    const url = 'ws://127.0.0.1:4455/';
    await rememberRecording(url, root, 'recorded.mkv');
    assert.equal((await lastRecording(url, root)).dateKind, 'completedAt');
    assert.equal(await lastRecording('ws://127.0.0.1:4456/', root), null);
    const media = join(root, 'media'); await mkdir(media);
    const file = join(media, 'manual.mp4'); await writeFile(file, 'test');
    const discovered = await lastRecording('ws://localhost:4455/', root, media);
    assert.equal(discovered.dateKind, 'modifiedAt');
    await utimes(file, new Date(Date.now() - 13 * 3600000), new Date(Date.now() - 13 * 3600000));
    assert.equal(await lastRecording('ws://localhost:4455/', root, media), null);
    assert.equal(await lastRecording('ws://remote:4455/', root, media), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
