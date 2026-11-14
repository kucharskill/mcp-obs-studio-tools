import { withObs, errorMessage } from './obs.js';

/** Read global audio and scene routing without changing settings.
 * @param {AbortSignal} [signal]
 */
export async function audio(signal) {
  return withObs(async obs => {
    const [inputs, special, sceneList] = await Promise.all([
      obs.call('GetInputList'), obs.call('GetSpecialInputs'), obs.call('GetSceneList'),
    ]);
    /** @type {{operation: string, input?: string, error: string}[]} */
    const warnings = [];
    /** @type {Map<string, {scene: string, activeScene: boolean, enabled: boolean, itemPath: string[]}[]>} */
    const membership = new Map();
    /** @type {Map<string, import('obs-websocket-js').OBSResponseTypes['GetSceneItemList']['sceneItems']>} */
    const cache = new Map();
    const sceneNames = new Set(sceneList.scenes.map(scene => scene.sceneName));
    /** @param {string} name @param {boolean} group @param {string} root @param {boolean} enabled @param {string[]} path @param {Set<string>} ancestors */
    async function visit(name, group, root, enabled, path, ancestors) {
      const key = `${group ? 'group' : 'scene'}:${name}`;
      if (ancestors.has(key) || ancestors.size > 64) { warnings.push({ operation: 'scene-membership', error: `Skipped cyclic or excessive nesting at ${name}` }); return; }
      let items = cache.get(key);
      if (!items) {
        try {
          items = group ? (await obs.call('GetGroupSceneItemList', { sceneName: name })).sceneItems : (await obs.call('GetSceneItemList', { sceneName: name })).sceneItems;
          cache.set(key, items);
        } catch (error) { warnings.push({ operation: 'scene-membership', error: errorMessage(error) }); return; }
      }
      for (const item of items) {
        if (typeof item.sourceName !== 'string') continue;
        const itemPath = [...path, item.sourceName];
        const itemEnabled = enabled && item.sceneItemEnabled === true;
        const placements = membership.get(item.sourceName) ?? [];
        placements.push({ scene: root, activeScene: root === sceneList.currentProgramSceneName, enabled: itemEnabled, itemPath });
        membership.set(item.sourceName, placements);
        if (item.isGroup === true || sceneNames.has(item.sourceName)) await visit(item.sourceName, item.isGroup === true, root, itemEnabled, itemPath, new Set([...ancestors, key]));
      }
    }
    for (const scene of sceneList.scenes) if (typeof scene.sceneName === 'string') await visit(scene.sceneName, false, scene.sceneName, true, [], new Set());

    const globals = Object.entries(special).filter((entry) => typeof entry[1] === 'string' && entry[1].length > 0);
    const candidates = new Map(inputs.inputs.filter(input => typeof input.inputName === 'string').map(input => [String(input.inputName), input]));
    for (const [, name] of globals) if (typeof name === 'string' && !candidates.has(name)) candidates.set(name, { inputName: name });
    const sources = [];
    for (const [name, input] of candidates) {
      signal?.throwIfAborted();
      let mute;
      try { mute = await obs.call('GetInputMute', { inputName: name }); }
      catch (error) {
        // OBS itself reports the audio capability; do not guess from plugin kinds.
        if (!/does not support audio/i.test(errorMessage(error))) warnings.push({ operation: 'GetInputMute', input: name, error: errorMessage(error) });
        continue;
      }
      const [volume, tracks, monitor] = await Promise.allSettled([
        obs.call('GetInputVolume', { inputName: name }), obs.call('GetInputAudioTracks', { inputName: name }), obs.call('GetInputAudioMonitorType', { inputName: name }),
      ]);
      for (const [operation, result] of /** @type {const} */ ([['GetInputVolume', volume], ['GetInputAudioTracks', tracks], ['GetInputAudioMonitorType', monitor]])) {
        if (result.status === 'rejected') warnings.push({ operation, input: name, error: errorMessage(result.reason) });
      }
      const audioTracks = tracks.status === 'fulfilled' ? tracks.value.inputAudioTracks : null;
      const slots = globals.filter(([, value]) => value === name).map(([slot]) => slot);
      sources.push({ name, uuid: input.inputUuid ?? null, kind: input.inputKind ?? null, global: slots.length > 0, globalSlots: slots,
        muted: mute.inputMuted,
        volume: volume.status === 'fulfilled' ? { db: volume.value.inputVolumeDb, multiplier: volume.value.inputVolumeMul } : null,
        audioTracks, assignedTracks: audioTracks ? Object.entries(audioTracks).filter(([, enabled]) => enabled === true).map(([track]) => Number(track)) : null,
        monitorType: monitor.status === 'fulfilled' ? monitor.value.monitorType : null,
        scenes: membership.get(name) ?? [],
      });
    }
    return { currentProgramScene: sceneList.currentProgramSceneName, globalDevices: special, sources, warnings,
      note: 'Enabled scene placement and track assignments do not prove audible output or inclusion in the recording. Recording encoder track selection, source activity and actual audio signal are separate.' };
  }, signal);
}
