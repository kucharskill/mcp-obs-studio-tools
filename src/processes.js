import si from 'systeminformation';
import { access, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';

/** @param {string} path */
export async function isExecutableFile(path) {
  if (!isAbsolute(path)) return false;
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

/** Read the Windows PE machine type instead of assuming bitness from a process name.
 * @param {string} path
 */
export async function binaryArchitecture(path) {
  if (process.platform !== 'win32') return null;
  const file = await open(path, 'r').catch(() => undefined);
  if (!file) return null;
  try {
    const header = Buffer.alloc(64);
    if ((await file.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ') return null;
    const offset = header.readUInt32LE(60);
    if (offset > 1024 * 1024) return null;
    const pe = Buffer.alloc(6);
    if ((await file.read(pe, 0, 6, offset)).bytesRead !== 6 || pe.readUInt32LE(0) !== 0x4550) return null;
    switch (pe.readUInt16LE(4)) {
      case 0x14c: return 'x86';
      case 0x8664: return 'x64';
      case 0xaa64: return 'arm64';
      default: return null;
    }
  } finally { await file.close(); }
}

/** @typedef {{pid: number, name: string, path: string}} ProcessInfo */
/** Return only OBS processes, without command-line arguments or unrelated processes.
 * Paths are checked before being used for executable discovery.
 * @param {() => Promise<{list: ProcessInfo[]}>} [readProcesses]
 */
export async function findObsProcesses(readProcesses = si.processes) {
  try {
    const { list } = await readProcesses();
    const processes = await Promise.all(list.filter(item => /^obs(?:32|64)?(?:\.exe)?$/i.test(item.name)).map(async item => {
      const executable = item.path && await isExecutableFile(item.path) ? item.path : null;
      return { pid: item.pid, name: item.name, executable, architecture: executable ? await binaryArchitecture(executable) : null };
    }));
    return { processes, processScanError: null };
  } catch (error) {
    return { processes: [], processScanError: error instanceof Error ? error.message : String(error) };
  }
}
