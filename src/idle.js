import { diagnostic } from './diagnostics.js';

/** One worker-owned counter, deadline and timer for all backend requests.
 * @param {{discoveryMs: number, callMs: number, close: (reason: string) => void|Promise<void>, log?: typeof diagnostic, now?: () => number}} options
 */
export function createIdleLifecycle({ discoveryMs, callMs, close, log = diagnostic, now = Date.now }) {
  let active = 0;
  let expiresAt = now() + discoveryMs;
  let closing = false;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @param {string} method @param {string} reason */
  const report = (method, reason) => log({ role: 'worker', method, active, expiresAt, reason });
  const arm = () => {
    clearTimeout(timer);
    if (!closing && active === 0) timer = setTimeout(() => {
      if (active !== 0 || closing) return;
      if (now() < expiresAt) { arm(); return; }
      closing = true;
      report('lifecycle', 'idle-expired');
      void close('idle-expired');
    }, Math.max(0, expiresAt - now()));
  };
  arm();
  return {
    /** @template T @param {'tools/list'|'tools/call'} method @param {() => T|Promise<T>} action */
    async during(method, action) {
      if (closing) throw new Error('Worker is shutting down');
      active++;
      clearTimeout(timer);
      report(method, 'request-start');
      try { return await action(); }
      finally {
        active--;
        expiresAt = Math.max(expiresAt, now() + (method === 'tools/list' ? discoveryMs : callMs));
        report(method, 'request-complete');
        arm();
      }
    },
    snapshot: () => ({ active, expiresAt, closing }),
    /** @param {string} reason */
    stop(reason) {
      clearTimeout(timer);
      const alreadyClosing = closing;
      closing = true;
      if (!alreadyClosing) report('lifecycle', reason);
    },
  };
}
