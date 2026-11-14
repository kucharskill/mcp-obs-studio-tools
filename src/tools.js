import { z } from 'zod';
import { serverInfo } from './package.js';
import { auth, status, record, screenshot, execute, errorMessage, scenes, setScene } from './obs.js';
import { findCommands, commandIndex } from './catalog.js';
import { launch } from './launch.js';
import { audio } from './audio.js';

const empty = z.strictObject({});
const request = z.strictObject({ requestType: z.string().min(1), requestData: z.record(z.string(), z.unknown()).optional() });
const definitions = {
  obs_launch: { description: 'Launch the OBS application. Does not enable or verify WebSocket. Then call obs_auth. Repeated calls may launch another OBS instance.', schema: z.strictObject({ executable: z.string().optional(), args: z.array(z.string()).max(32).optional() }) },
  obs_auth: { description: 'Configure OBS access and return the same unified result as obs_status. Without arguments, simply check status; no separate authentication probe or persistent session is created. Optional address, port and password override defaults and are saved to the selected dotenv file before checking status, even if access fails. Omitted values use configuration. Never return the password. Failures include connected=false, errorCode and userAction. Other operations authenticate transparently; calling obs_auth first is not required.', schema: z.strictObject({ address: z.string().trim().min(1).describe('Host/IP or ws:// / wss:// URL. Default: configured OBS_URL, initially ws://127.0.0.1:4455. Saved as OBS_URL.').optional(), port: z.number().int().min(1).max(65535).describe('WebSocket port. Overrides the port in the address or configured URL. Saved within OBS_URL.').optional(), password: z.string().describe('WebSocket password. Saved as OBS_PASSWORD in the selected dotenv file. Empty string clears the stored password. Omit to use configuration.').optional() }) },
  obs_record_start: { description: 'Start recording in OBS. Recording continues after this operation disconnects.', schema: empty },
  obs_record_stop: { description: 'Stop recording and return the output file path and completion timestamp.', schema: empty },
  obs_audio: { description: 'Read all audio-capable inputs, global desktop/mic slots, scene placements (including groups and nested scenes), mute, volume, monitoring and audio track assignments. Enabled placements are not proof of audible output or recording inclusion. Does not change audio settings. Returns partial field failures in warnings.', schema: empty },
  obs_scenes: { description: 'List OBS scenes with names, UUIDs, the active program scene and each scene\'s enabledElements (names, IDs and types). Enabled means the scene-item visibility flag is on, not that the scene is on air or a media source is playing. Lists direct items only; groups and nested scenes are named but not expanded.', schema: empty },
  obs_scene_set: { description: 'Switch the active program scene by its exact name from obs_scenes. This changes the live program output, including in Studio Mode. Return the requested name and current program scene after the request.', schema: z.strictObject({ name: z.string().min(1).describe('Exact OBS scene name returned by obs_scenes.') }) },
  obs_status: { description: 'Locate the local OBS executable in priority order: running OBS process paths, OBS_EXECUTABLE, default installation folders, PATH. Verify file existence and save the discovered path as OBS_EXECUTABLE in the selected dotenv file. Return installation.executable, architecture, OBS processes with PIDs, source, checkedPaths and persistence result, even when WebSocket is unavailable, without launching OBS. Get connectivity, active program scene, recording and streaming status. Include last recording if at most 12 hours old, with path, ISO date and dateKind. File discovery uses modification time, not a verified completion time.', schema: empty },
  obs_screenshot: { description: 'Return a PNG image of the active program scene.', schema: z.strictObject({ width: z.number().int().min(32).max(3840).optional(), height: z.number().int().min(32).max(2160).optional() }) },
  obs_commands: { description: `Discover additional OBS commands. Use query to search English words, or name to get an exact command's description, parameter types, required fields, restrictions and response fields. Before obs_execute, inspect the command with name and retrieve any required scene/input names or IDs from OBS using the appropriate list command. Offline catalog; actual support depends on the connected OBS version. obs_auth returns availableRequests for that instance.\n\n${commandIndex()}`, schema: z.strictObject({ query: z.string().max(200).describe('English search words matched against command names, categories and descriptions. Omit to browse.').optional(), name: z.string().describe('Exact command name from the index. Returns full help; takes precedence over query and pagination.').optional(), offset: z.number().int().nonnegative().describe('Number of search results to skip. Default: 0.').optional(), limit: z.number().int().min(1).max(50).describe('Maximum search results to return. Default: 20. Does not limit the index in this tool description.').optional() }) },
  obs_execute: { description: 'Execute one command or a serial sequence from obs_commands. Validate all commands first. Sequences are not atomic and have no rollback. Never automatically retry a failed operation: check status first.', schema: z.strictObject({ requests: z.array(request).min(1).max(100), haltOnFailure: z.boolean().default(true) }) },
};

export function manifest() {
  return { protocol: 1, serverInfo, tools: Object.entries(definitions).map(([name, value]) => ({ name, description: value.description, inputSchema: /** @type {import('@modelcontextprotocol/server').Tool['inputSchema']} */ (z.toJSONSchema(value.schema, { target: 'draft-7' })) })) };
}

/** @param {unknown} value @returns {import('@modelcontextprotocol/server').CallToolResult} */
export function textResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }

/** @param {string} name @param {unknown} args @param {AbortSignal} [signal] @returns {Promise<import('@modelcontextprotocol/server').CallToolResult>} */
export async function executeTool(name, args, signal) {
  try {
    switch (name) {
      case 'obs_launch': return textResult(await launch(definitions.obs_launch.schema.parse(args)));
      case 'obs_auth': {
        const result = await auth(definitions.obs_auth.schema.parse(args), signal);
        return { ...textResult(result), ...(!result.connected && { isError: true }) };
      }
      case 'obs_status': empty.parse(args); return textResult(await status(signal));
      case 'obs_record_start': empty.parse(args); return textResult(await record('StartRecord', signal));
      case 'obs_record_stop': empty.parse(args); return textResult(await record('StopRecord', signal));
      case 'obs_audio': empty.parse(args); return textResult(await audio(signal));
      case 'obs_scenes': empty.parse(args); return textResult(await scenes(signal));
      case 'obs_scene_set': return textResult(await setScene(definitions.obs_scene_set.schema.parse(args).name, signal));
      case 'obs_commands': return textResult(findCommands(definitions.obs_commands.schema.parse(args)));
      case 'obs_execute': {
        const input = definitions.obs_execute.schema.parse(args);
        const result = await execute(input.requests, input.haltOnFailure, signal);
        return { ...textResult(result), ...(!result.allSucceeded && { isError: true }) };
      }
      case 'obs_screenshot': {
        const result = await screenshot(definitions.obs_screenshot.schema.parse(args), signal);
        return { content: [{ type: 'text', text: JSON.stringify({ scene: result.scene }) }, { type: 'image', mimeType: 'image/png', data: result.data }] };
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) { return { ...textResult({ error: errorMessage(error) }), isError: true }; }
}
