/** Lifecycle diagnostics contain transport state only, never arguments or configuration values.
 * @param {Record<string, unknown>} event
 */
export function diagnostic(event) {
  if (process.env.OBS_MCP_DIAGNOSTICS !== '0') console.error(JSON.stringify({ component: 'obs-mcp', time: new Date().toISOString(), pid: process.pid, ...event }));
}
