# OBS Studio MCP Tools

Control OBS Studio through an MCP agent: inspect status, launch OBS, record, capture the active scene, switch scenes and inspect audio routing. Discover additional operations through a searchable catalog generated from the official OBS WebSocket protocol.

Available on [npm](https://www.npmjs.com/package/mcp-obs-studio-tools), with source and releases on [GitHub](https://github.com/kucharskill/mcp-obs-studio-tools).

Requires Node.js 24.12+ with npm and OBS Studio 28+ with its WebSocket server enabled under **Tools > WebSocket Server Settings**.

## MCP setup

```sh
npx -y --prefer-online mcp-obs-studio-tools@latest mcp
```

```json
{
  "mcpServers": {
    "obs": {
      "command": "npx",
      "args": ["-y", "--prefer-online", "mcp-obs-studio-tools@latest", "mcp"],
      "env": {
        "OBS_ENV_FILE": "/absolute/path/obs.env"
      }
    }
  }
}
```

Set the client's startup and tool timeouts to 180 seconds. On Windows, clients requiring an executable extension can use `npx.cmd`.

Copy `.env.example` to your selected configuration file and enter the WebSocket settings. Alternatively, append `--env-file /absolute/path/obs.env` to the command. The aliases `-env_file` and `--env_file` are supported.

## Tools

| Tool | Purpose |
| --- | --- |
| `obs_status` | OBS process/executable, connection, version, active scene, recording, streaming and last recording within 12 hours. |
| `obs_auth` | Save supplied address, port and password, then return status. Omitted values use configuration. |
| `obs_launch` | Launch OBS using a detected executable or an explicit path. |
| `obs_record_start` | Start recording. |
| `obs_record_stop` | Stop recording and return the file path and completion date. |
| `obs_screenshot` | Return a PNG of the active program scene. Default width: 1280 px. |
| `obs_scenes` | Scene names/UUIDs, active scene and directly enabled elements. |
| `obs_scene_set` | Switch the live program scene by exact name. |
| `obs_audio` | Global and scene audio sources, mute, volume, monitoring and track assignments. |
| `obs_commands` | Full command-name index, English search and detailed argument help. |
| `obs_execute` | Execute catalog commands individually or in serial sequences. |

Typical agent workflow:

```js
obs_status({})
obs_auth({ address: "127.0.0.1", port: 4455 })
obs_scenes({})
obs_scene_set({ name: "Camera" })
obs_record_start({})
obs_record_stop({})
```

Start with status. Use `obs_launch` when the local application needs starting and `obs_auth` to configure access. Connection errors return an `errorCode` and actionable `userAction`.

For additional operations, search, inspect arguments, retrieve required names/IDs from OBS, then execute:

```js
obs_commands({ query: "volume" })
obs_commands({ name: "SetInputVolume" })
obs_execute({ requests: [{
  requestType: "SetInputVolume",
  requestData: { inputName: "Microphone", inputVolumeDb: -6 }
}] })
```

Sequences validate all commands before execution and stop on failure by default. Completed changes remain applied. Check status before retrying an interrupted operation.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `OBS_URL` | `ws://127.0.0.1:4455` |
| `OBS_PASSWORD` | WebSocket password |
| `OBS_ENV_FILE` | `.env` in the startup working directory |
| `OBS_EXECUTABLE` | Detected or configured absolute OBS executable path |
| `OBS_TIMEOUT_MS` | `15000`, per OBS operation |
| `OBS_WORKER_IDLE_MS` | `1800000`, retention after a completed tool call |
| `OBS_WORKER_DISCOVERY_IDLE_MS` | `60000`, retention after backend discovery |
| `OBS_DISCOVERY_CACHE_MS` | `600000`, shared discovery cache lifetime; `0` disables it |
| `OBS_DISCOVERY_CACHE_DIR` | System temporary directory under `obs-mcp/discovery` |
| `OBS_DISCOVERY_CACHE_EXCLUDE_ENV` | Comma-separated additional environment names excluded from the cache key. `CODEX_TOOL_CALL_ID`, `PATH`, and names starting with `INIT_` or `NPM_` are always excluded, case-insensitively |
| `OBS_MCP_REQUEST_TIMEOUT_MS` | `180000`, MCP response deadline |
| `OBS_STATE_DIR` | Recording history; defaults to the system temporary directory under `obs-mcp` |
| `OBS_MCP_RUNNER` | `auto`, `local` or `latest` |

Connection precedence: current `obs_auth` arguments, process environment, selected env file, built-in defaults. Supplied connection settings are saved to the selected file. Workers reload it for subsequent calls. Executable discovery checks running OBS processes, `OBS_EXECUTABLE`, standard installation folders and `PATH`, then saves the verified path.

Outputs include JSON status/results, PNG screenshots and recording file paths. Recent recording dates use ISO 8601 UTC: observed stops are marked `completedAt`; local recording-directory discovery uses `modifiedAt`. Audio track assignments describe source routing; recording settings select the output tracks. Enabled scene items describe visibility settings, while audio activity and media playback have their own states.

## Worker lifecycle

The wrapper serves discovery from a shared file cache in the user's temporary directory, including initialization in another wrapper and discovery after worker expiry. Cache hits preserve the original expiry and leave the worker lifecycle untouched. The cache key hashes the target command, arguments, working directory and sorted environment, with case-insensitive environment names on Windows. Exclusions affect only the key; the full environment reaches the worker. Files contain tool metadata and hashed context fingerprints, with atomic writes and a default lifetime of 10 minutes. Cache age, changes to the selected env file or local source files, tool-list notifications and detected backend identity changes trigger a metadata refresh. Ordinary tool results are executed live.

Legacy MCP ping receives a local response from the wrapper's SDK handler. Modern MCP uses its negotiated protocol without adding the removed ping RPC. Initialization and discovery negotiate capabilities through the SDK; cached records contain tool definitions and server identity, independent of client sessions.

At startup, each MCP wrapper appends one `{pid, startedAt, env}` record containing its original process environment to `env-startup.jsonl` beside the cache. This local diagnostic file can contain credentials and uses owner-only permissions where supported. Snapshot failures leave MCP operation unaffected.

The worker owns one active-request counter, one expiry deadline and one idle timer. Backend discovery retains it for 1 minute; completed tool calls retain it for 30 minutes. Each completion extends the deadline using the greater of its current value and the new retention window, so discovery preserves any longer tool-call deadline. Active requests suspend expiry until their application work settles, including cancellation cleanup. The worker exits itself at the deadline, and the next backend operation starts another. OBS continues running independently.

MCP response deadlines limit client waiting separately from worker activity. Lifecycle diagnostics on stderr report methods, cache hits/misses, activity, expiry and close reasons. Set `OBS_MCP_DIAGNOSTICS=0` in the launching environment to disable diagnostics.

An npx wrapper starts workers through `npx ...@latest`, resolving updates at each worker startup. Direct Node.js or installed-binary launches use the same local installation. The wrapper passes through the selected env-file path. Updating the wrapper itself takes effect when its MCP connection restarts.

## Local CLI and development

```sh
npm ci
node src/cli.js mcp --env-file /absolute/path/obs.env
node src/cli.js --tool-manifest
node src/cli.js --version
```

A single tool call accepts JSON on stdin:

```sh
echo '{"name":"GetVersion"}' | node src/cli.js --execute-tool obs_commands
```

JavaScript ESM with JSDoc. Run `npm run check` for type checking and tests, `npm run catalog:update` to refresh the command catalog, and `npm outdated` to review dependencies. Dependabot checks npm dependencies weekly. CI checks Windows and Linux.

## License

GPL-2.0-only. The bundled command catalog comes from [obsproject/obs-websocket](https://github.com/obsproject/obs-websocket); its source revision and license are included in `data/`. OBS communication uses [obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js).
