import { OBSWebSocket } from 'obs-websocket-js/json';
import { config, envFilePath, configureConnection } from './config.js';
import { rememberRecording, lastRecording } from './history.js';
import { validateCommand } from './catalog.js';
import { findExecutable } from './launch.js';

/** @typedef {{requestType: string, requestData?: Record<string, unknown>}} Request */

/** @param {unknown} error */
export function errorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  let password = process.env.OBS_PASSWORD;
  try { password = config().password; } catch { /* Configuration errors must also be reportable. */ }
  if (password) message = message.replaceAll(password, '[redacted]');
  return message;
}

/** @param {unknown} error @param {boolean} [hasPassword] */
export function connectionFailure(error, hasPassword = Boolean(config().password)) {
  const message = errorMessage(error);
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 4009 || /authentication.*(?:required|failed)|missing an `authentication`/i.test(message)) {
    return { error: message, errorCode: hasPassword ? 'OBS_AUTHENTICATION_FAILED' : 'OBS_AUTHENTICATION_REQUIRED', userAction: `The WebSocket server is reachable. Ask the user to check its password in OBS Tools > WebSocket Server Settings and set OBS_PASSWORD in ${envFilePath()} or supply password to obs_auth. Do not ask them to paste the password into chat. Retry obs_auth after configuration is updated.` };
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(message)) {
    return { error: message, errorCode: 'OBS_WEBSOCKET_UNAVAILABLE', userAction: 'Ask the user to ensure OBS is running, open Tools > WebSocket Server Settings, enable the WebSocket server and apply the settings. Verify the host and port, then retry obs_auth.' };
  }
  return { error: message, errorCode: 'OBS_CONNECTION_FAILED', userAction: 'Check the host, port, network reachability and OBS WebSocket Server Settings, then retry obs_auth.' };
}

/** @template T @param {(obs: OBSWebSocket, settings: ReturnType<typeof config>) => Promise<T>} action @param {AbortSignal} [signal] @param {ReturnType<typeof config>} [settings] */
export async function withObs(action, signal, settings = config()) {
  const obs = new OBSWebSocket();
  const abort = () => { void obs.disconnect().catch(() => {}); };
  const timeout = AbortSignal.timeout(settings.timeout);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  /** @type {(() => void)|undefined} */
  let removeReject;
  const cancelled = new Promise((_, reject) => {
    const handler = () => { abort(); reject(new Error('OBS operation cancelled or timed out; it may already have taken effect. Check obs_status before retrying.')); };
    combined.addEventListener('abort', handler, { once: true });
    removeReject = () => combined.removeEventListener('abort', handler);
  });
  try {
    combined.throwIfAborted();
    return await Promise.race([(async () => {
      await obs.connect(settings.url, settings.password, { rpcVersion: 1, eventSubscriptions: 0 });
      combined.throwIfAborted();
      return action(obs, settings);
    })(), cancelled]);
  } finally {
    removeReject?.();
    await obs.disconnect().catch(() => {});
  }
}

/** @param {{address?: string, port?: number, password?: string}} [options] @param {AbortSignal} [signal] */
export async function auth(options = {}, signal) {
  const settings = await configureConnection(options);
  return status(signal, settings);
}

/** Unified status used directly by MCP/CLI and composed by authentication.
 * @param {AbortSignal} [signal] @param {ReturnType<typeof config>} [settings]
 */
export async function status(signal, settings = config()) {
  const installation = await findExecutable(settings.executable);
  try {
    return await withObs(async obs => {
      const version = await obs.call('GetVersion');
      const recording = await obs.call('GetRecordStatus');
      const streaming = await obs.call('GetStreamStatus');
      const scene = await obs.call('GetCurrentProgramScene');
      const directory = recording.outputActive ? undefined : await obs.call('GetRecordDirectory').then(result => result.recordDirectory).catch(() => undefined);
      return { connected: true, url: settings.url, ...version, installation, scene, recording, streaming, lastRecording: await lastRecording(settings.url, settings.stateDir, directory) };
    }, signal, settings);
  } catch (error) {
    const diagnostics = connectionFailure(error, Boolean(settings.password));
    if (settings.password) diagnostics.error = diagnostics.error.replaceAll(settings.password, '[redacted]');
    return { connected: false, url: settings.url, installation, ...diagnostics, lastRecording: await lastRecording(settings.url, settings.stateDir, undefined) };
  }
}

/** @param {'StartRecord'|'StopRecord'} request @param {AbortSignal} [signal] */
export async function record(request, signal) {
  return withObs(async (obs, settings) => {
    if (request === 'StartRecord') { await obs.call('StartRecord'); return { recording: true }; }
    const result = await obs.call('StopRecord');
    try { return { recording: false, ...result, lastRecording: await rememberRecording(settings.url, settings.stateDir, result.outputPath) }; }
    catch (error) { return { recording: false, ...result, historyWarning: errorMessage(error) }; }
  }, signal);
}

/** List each scene with its directly enabled items, independently of whether it is on air.
 * @param {AbortSignal} [signal]
 */
export async function scenes(signal) {
  return withObs(async obs => {
    const list = await obs.call('GetSceneList');
    const result = [];
    for (const scene of list.scenes) {
      if (typeof scene.sceneName !== 'string') throw new Error('OBS returned a scene without a name');
      const items = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
      result.push({
        name: scene.sceneName,
        uuid: scene.sceneUuid ?? null,
        active: scene.sceneName === list.currentProgramSceneName,
        enabledElements: items.sceneItems.filter(item => item.sceneItemEnabled === true).map(item => ({
          name: item.sourceName, uuid: item.sourceUuid ?? null, itemId: item.sceneItemId,
          type: item.inputKind ?? item.sourceType, isGroup: item.isGroup === true,
        })),
      });
    }
    return { currentProgramScene: list.currentProgramSceneName, scenes: result };
  }, signal);
}

/** @param {string} name @param {AbortSignal} [signal] */
export async function setScene(name, signal) {
  return withObs(async obs => {
    await obs.call('SetCurrentProgramScene', { sceneName: name });
    const scene = await obs.call('GetCurrentProgramScene');
    return { requestedScene: name, currentProgramScene: scene.currentProgramSceneName, uuid: scene.currentProgramSceneUuid ?? null, active: scene.currentProgramSceneName === name };
  }, signal);
}

/** @param {{width?: number, height?: number}} args @param {AbortSignal} [signal] */
export async function screenshot(args, signal) {
  return withObs(async obs => {
    const scene = await obs.call('GetCurrentProgramScene');
    const result = await obs.call('GetSourceScreenshot', { sourceName: scene.currentProgramSceneName, imageFormat: 'png', imageWidth: args.width ?? 1280, ...(args.height && { imageHeight: args.height }) });
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(result.imageData);
    if (!match) throw new Error('OBS returned an invalid PNG screenshot');
    return { scene: scene.currentProgramSceneName, data: match[1] };
  }, signal);
}

/** @param {Request[]} requests @param {boolean} haltOnFailure @param {AbortSignal} [signal] */
export async function execute(requests, haltOnFailure, signal) {
  // Validate the whole sequence before any operation can change OBS.
  for (const request of requests) validateCommand(request.requestType, request.requestData ?? {});
  return withObs(async (obs, settings) => {
    const version = await obs.call('GetVersion');
    for (const request of requests) if (!version.availableRequests.includes(request.requestType)) throw new Error(`Command not supported by this OBS instance: ${request.requestType}`);
    /** @type {Record<string, unknown>[]} */
    const results = [];
    // Serial calls allow recording stops to be persisted, including within a sequence.
    for (const request of requests) {
      signal?.throwIfAborted();
      try {
        // Dynamic commands are validated against the bundled official protocol catalog.
        const response = await obs.call(/** @type {any} */ (request.requestType), /** @type {any} */ (request.requestData ?? {}));
        const result = { requestType: request.requestType, ok: true, response };
        results.push(result);
        if (request.requestType === 'StopRecord' && response && 'outputPath' in response && typeof response.outputPath === 'string') {
          try { await rememberRecording(settings.url, settings.stateDir, response.outputPath); }
          catch (error) { results.push({ warning: 'Recording stopped, but history could not be saved', error: errorMessage(error) }); }
        }
      } catch (error) {
        results.push({ requestType: request.requestType, ok: false, error: errorMessage(error) });
        if (haltOnFailure) break;
      }
    }
    return { results, allSucceeded: results.every(result => result.ok !== false), atomic: false };
  }, signal);
}
