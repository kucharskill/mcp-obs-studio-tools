import { tempDir } from './temp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { executeTool } from '../src/tools.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';

test('real OBS client: handshake, recording, history, screenshot, errors, disconnects and stdio adapter', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const root = await tempDir('obs-api-test-');
  const oldEnv = { ...process.env };
  process.env.OBS_URL = `ws://127.0.0.1:${server.address().port}`;
  process.env.OBS_STATE_DIR = root;
  process.env.OBS_TIMEOUT_MS = '1000';
  process.env.OBS_PASSWORD = '';
  process.env.OBS_ENV_FILE = join(root, '.env');
  await writeFile(process.env.OBS_ENV_FILE, `# Wrapper and worker configuration\nOBS_URL=${process.env.OBS_URL}\nOBS_PASSWORD=\nOBS_STATE_DIR='${root}'\n`);
  let requireAuth = false, stall = false;
  let active = false, connections = 0, openedConnections = 0, requests = [], programScene = 'Test scene';
  server.on('connection', socket => {
    connections++;
    openedConnections++;
    socket.on('close', () => connections--);
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.7.2', rpcVersion: 1, ...(requireAuth && { authentication: { salt: 'test-salt', challenge: 'test-challenge' } }) } }));
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.op === 1) {
        const hash = value => createHash('sha256').update(value).digest('base64');
        if (requireAuth && message.d.authentication !== hash(hash('test-password' + 'test-salt') + 'test-challenge')) { socket.close(4009, 'Authentication failed'); return; }
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })); return;
      }
      if (message.op !== 6) return;
      if (stall) return;
      const { requestType, requestId } = message.d;
      requests.push(requestType);
      let responseData = {}, ok = true, comment = 'Not recording';
      switch (requestType) {
        case 'GetVersion': responseData = { obsVersion: 'test', obsWebSocketVersion: '5.7.2', availableRequests: ['GetVersion', 'StartRecord', 'StopRecord', 'GetRecordStatus'] }; break;
        case 'GetRecordStatus': responseData = { outputActive: active, outputPaused: false }; break;
        case 'GetStreamStatus': responseData = { outputActive: false }; break;
        case 'GetCurrentProgramScene': responseData = { currentProgramSceneName: programScene }; break;
        case 'GetSceneList': responseData = { currentProgramSceneName: programScene, scenes: [{ sceneName: 'Test scene', sceneUuid: 'scene-1' }, { sceneName: 'Second scene', sceneUuid: 'scene-2' }] }; break;
        case 'GetSceneItemList': responseData = { sceneItems: [{ sourceName: 'Camera', sceneItemId: 1, sceneItemEnabled: true }, { sourceName: 'Hidden', sceneItemId: 2, sceneItemEnabled: false }, { sourceName: 'Audio group', sceneItemId: 3, sceneItemEnabled: false, isGroup: true }] }; break;
        case 'GetGroupSceneItemList': responseData = { sceneItems: [{ sourceName: 'Microphone', sceneItemId: 4, sceneItemEnabled: true }] }; break;
        case 'GetInputList': responseData = { inputs: [{ inputName: 'Camera', inputKind: 'video_capture' }, { inputName: 'Microphone', inputKind: 'audio_capture' }, { inputName: 'Hidden', inputKind: 'ffmpeg_source' }] }; break;
        case 'GetSpecialInputs': responseData = { desktop1: null, desktop2: null, mic1: 'Microphone', mic2: null, mic3: null, mic4: null }; break;
        case 'GetInputMute':
          if (message.d.requestData.inputName === 'Camera') { ok = false; comment = 'The specified input does not support audio.'; }
          else responseData = { inputMuted: message.d.requestData.inputName === 'Microphone' };
          break;
        case 'GetInputVolume': responseData = { inputVolumeDb: -6, inputVolumeMul: 0.5 }; break;
        case 'GetInputAudioTracks': responseData = { inputAudioTracks: { 1: true, 2: false, 3: true, 4: false, 5: false, 6: false } }; break;
        case 'GetInputAudioMonitorType':
          if (message.d.requestData.inputName === 'Hidden') { ok = false; comment = 'Monitoring unavailable'; }
          else responseData = { monitorType: 'OBS_MONITORING_TYPE_NONE' };
          break;
        case 'SetCurrentProgramScene':
          if (['Test scene', 'Second scene'].includes(message.d.requestData.sceneName)) programScene = message.d.requestData.sceneName;
          else ok = false;
          break;
        case 'GetRecordDirectory': responseData = { recordDirectory: root }; break;
        case 'StartRecord': active = true; break;
        case 'StopRecord': if (!active) ok = false; active = false; responseData = { outputPath: join(root, 'test.mkv') }; break;
        case 'GetSourceScreenshot': responseData = { imageData: 'data:image/png;base64,iVBORw0KGgo=' }; break;
      }
      socket.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: ok, code: ok ? 100 : 500, comment: ok ? undefined : comment }, responseData } }));
    });
  });
  const call = (name, args = {}) => executeTool(name, args);
  try {
    assert.equal(JSON.parse((await call('obs_auth')).content[0].text).connected, true);
    const baselineStatus = JSON.parse((await call('obs_status')).content[0].text);
    const connectionsBeforeAuth = openedConnections;
    const requestsBeforeAuth = requests.length;
    const authStatus = JSON.parse((await call('obs_auth')).content[0].text);
    assert.deepEqual(authStatus, baselineStatus);
    assert.equal(openedConnections - connectionsBeforeAuth, 1);
    assert.equal(requests.slice(requestsBeforeAuth).filter(name => name === 'GetVersion').length, 1);
    assert.equal((await call('obs_record_start')).isError, undefined);
    assert.equal(JSON.parse((await call('obs_status')).content[0].text).recording.outputActive, true);
    const stopped = JSON.parse((await call('obs_record_stop')).content[0].text);
    assert.equal(stopped.lastRecording.dateKind, 'completedAt');
    assert.ok(JSON.parse((await call('obs_status')).content[0].text).lastRecording.date);
    assert.equal((await call('obs_record_stop')).isError, true);
    assert.equal((await call('obs_screenshot')).content[1].type, 'image');
    const listed = JSON.parse((await call('obs_scenes')).content[0].text);
    assert.equal(listed.scenes.length, 2);
    assert.equal(listed.scenes[0].active, true);
    assert.deepEqual(listed.scenes[0].enabledElements.map(item => item.name), ['Camera']);
    const switched = JSON.parse((await call('obs_scene_set', { name: 'Second scene' })).content[0].text);
    assert.equal(switched.active, true);
    assert.equal(JSON.parse((await call('obs_scenes')).content[0].text).scenes[1].active, true);
    assert.equal((await call('obs_scene_set', { name: 'Missing' })).isError, true);
    assert.equal(programScene, 'Second scene');
    const audio = JSON.parse((await call('obs_audio')).content[0].text);
    assert.equal(audio.sources.length, 2);
    assert.ok(!audio.sources.some(source => source.name === 'Camera'));
    const mic = audio.sources.find(source => source.name === 'Microphone');
    assert.equal(mic.global, true);
    assert.deepEqual(mic.globalSlots, ['mic1']);
    assert.equal(mic.muted, true);
    assert.deepEqual(mic.assignedTracks, [1, 3]);
    assert.equal(mic.volume.db, -6);
    assert.ok(mic.scenes.every(placement => placement.enabled === false));
    assert.ok(mic.scenes.some(placement => placement.activeScene));
    assert.deepEqual(mic.scenes[0].itemPath, ['Audio group', 'Microphone']);
    const media = audio.sources.find(source => source.name === 'Hidden');
    assert.equal(media.global, false);
    assert.equal(media.monitorType, null);
    assert.equal(audio.warnings.length, 1);
    assert.equal(audio.warnings[0].operation, 'GetInputAudioMonitorType');
    const before = requests.length;
    assert.equal((await call('obs_execute', { requests: [{ requestType: 'StartRecord' }, { requestType: 'Invalid' }] })).isError, true);
    assert.equal(requests.length, before);
    const sequence = await call('obs_execute', { requests: [{ requestType: 'StopRecord' }, { requestType: 'StartRecord' }] });
    assert.equal(sequence.isError, true); assert.equal(active, false);

    const childEnv = { ...process.env, OBS_MCP_RUNNER: 'local' };
    delete childEnv.OBS_URL; delete childEnv.OBS_ENV_FILE; delete childEnv.OBS_STATE_DIR;
    const transport = new StdioClientTransport({ command: process.execPath, args: ['src/cli.js', 'mcp', '-env_file', join(root, '.env')], env: childEnv, stderr: 'pipe' });
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 11);
      assert.equal((await client.callTool({ name: 'obs_auth', arguments: {} })).isError, undefined);
      const savedEnv = await readFile(join(root, '.env'), 'utf8');
      await writeFile(join(root, '.env'), savedEnv + '\nOBS_URL=ws://127.0.0.1:1\n');
      assert.equal((await client.callTool({ name: 'obs_auth', arguments: {} })).isError, true);
      await writeFile(join(root, '.env'), savedEnv);
      assert.equal((await client.callTool({ name: 'obs_auth', arguments: {} })).isError, undefined);
      const catalog = await client.callTool({ name: 'obs_commands', arguments: { name: 'StopRecord' } });
      assert.equal(JSON.parse(catalog.content[0].text).command.requestType, 'StopRecord');
    } finally { await client.close(); }
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(connections, 0);
    requireAuth = true;
    process.env.OBS_PASSWORD = 'test-password';
    assert.equal((await call('obs_auth')).isError, undefined);
    process.env.OBS_PASSWORD = 'wrong-password';
    const authError = await call('obs_auth');
    assert.equal(authError.isError, true);
    assert.equal(JSON.parse(authError.content[0].text).errorCode, 'OBS_AUTHENTICATION_FAILED');
    assert.ok(!JSON.stringify(authError).includes('wrong-password'));
    process.env.OBS_PASSWORD = '';
    const missingAuth = JSON.parse((await call('obs_auth')).content[0].text);
    assert.equal(missingAuth.errorCode, 'OBS_AUTHENTICATION_REQUIRED');
    assert.match(missingAuth.userAction, /OBS_PASSWORD/);
    process.env.OBS_URL = 'ws://127.0.0.1:1';
    const supplied = await call('obs_auth', { address: '127.0.0.1', port: server.address().port, password: 'test-password' });
    assert.equal(supplied.isError, undefined);
    assert.ok(!JSON.stringify(supplied).includes('test-password'));
    const saved = dotenv.parse(await readFile(process.env.OBS_ENV_FILE, 'utf8'));
    assert.equal(saved.OBS_PASSWORD, 'test-password');
    assert.equal(new URL(saved.OBS_URL).port, String(server.address().port));
    delete process.env.OBS_PASSWORD; delete process.env.OBS_URL;
    assert.equal((await call('obs_auth')).isError, undefined);
    assert.equal((await call('obs_auth', { address: '127.0.0.1' })).isError, undefined);
    process.env.OBS_PASSWORD = 'test-password';
    stall = true;
    process.env.OBS_TIMEOUT_MS = '100';
    assert.equal((await call('obs_auth')).isError, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(connections, 0);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    process.env = oldEnv;
    await rm(root, { recursive: true, force: true });
  }
});
