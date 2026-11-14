import { spawn } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { config, saveExecutable } from './config.js';
import { findObsProcesses, isExecutableFile, binaryArchitecture } from './processes.js';

/** Locate OBS without launching it: running processes, configured path, installation folders, PATH.
 * @param {string} [executable] @param {NodeJS.ProcessEnv} [env] @param {typeof findObsProcesses} [readProcesses]
 */
export async function findExecutable(executable, env = process.env, readProcesses = findObsProcesses) {
  /** @param {string} path @param {string} source @param {string[]} checkedPaths @param {Awaited<ReturnType<typeof findObsProcesses>>} observed */
  const found = async (path, source, checkedPaths, observed) => {
    let persistence;
    try { persistence = await saveExecutable(path, env); }
    catch (error) { persistence = { saved: false, error: error instanceof Error ? error.message : String(error) }; }
    return { executable: path, source, architecture: await binaryArchitecture(path), checkedPaths, ...observed, persistence };
  };
  const observed = await readProcesses();
  const runningPaths = [...new Set(observed.processes.map(item => item.executable).filter(path => path !== null))];
  const checkedPaths = [];
  for (const path of runningPaths) {
    checkedPaths.push(path);
    if (await isExecutableFile(path)) return found(path, 'running-process', checkedPaths, observed);
  }
  if (executable) {
    checkedPaths.push(executable);
    if (await isExecutableFile(executable)) return found(executable, 'configured', checkedPaths, observed);
  }
  // Do not even gather fallback paths until the process lookup has been exhausted.
  const defaults = process.platform === 'win32' ? [env.ProgramFiles ?? 'C:/Program Files', env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs')] : [])]
    .flatMap(root => [join(root, 'obs-studio/bin/64bit/obs64.exe'), join(root, 'obs-studio/bin/32bit/obs32.exe')])
    : process.platform === 'darwin' ? ['/Applications/OBS.app/Contents/MacOS/OBS', ...(env.HOME ? [join(env.HOME, 'Applications/OBS.app/Contents/MacOS/OBS')] : [])] : ['/usr/bin/obs', '/usr/local/bin/obs'];
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const names = process.platform === 'win32' ? ['obs64.exe', 'obs.exe', 'obs32.exe'] : ['obs'];
  const pathCandidates = pathValue.split(delimiter).map(directory => directory.replace(/^"|"$/g, '')).filter(isAbsolute).flatMap(directory => names.map(name => join(directory, name)));
  const candidates = [...new Set([...defaults, ...pathCandidates])];
  for (const path of candidates) {
    checkedPaths.push(path);
    if (!await isExecutableFile(path)) continue;
    return found(path, defaults.includes(path) ? 'installation-directory' : 'PATH', checkedPaths, observed);
  }
  return { executable: null, source: null, architecture: null, checkedPaths, ...observed };
}

/** @param {{executable?: string, args?: string[]}} options */
export async function launch({ executable, args = [] }) {
  // An explicit launch target is a user instruction; automatic discovery priorities
  // apply only when no target was supplied in the tool invocation.
  if (executable && (!isAbsolute(executable) || !await isExecutableFile(executable))) throw new Error('OBS executable must be an existing absolute executable file path');
  const found = executable ? { executable } : await findExecutable(config().executable);
  if (found.executable) {
    const path = found.executable;
    const child = spawn(path, args, { cwd: dirname(path), detached: true, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { launched: true, pid: child.pid, executable: path, websocketChecked: false, next: 'Call obs_auth to verify WebSocket readiness. Launching OBS does not enable its WebSocket server.' };
  }
  throw new Error('OBS executable not found. Set OBS_EXECUTABLE or supply an absolute executable path.');
}
