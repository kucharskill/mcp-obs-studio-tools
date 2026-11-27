import { diagnostic } from './diagnostics.js';

/** Wrapper-local metadata cache. Hits never contact or keep alive a worker.
 * @template T
 * @param {{load: () => Promise<T>, context: () => string, ttlMs: number, log?: typeof diagnostic, now?: () => number}} options
 */
export function createDiscoveryCache({ load, context, ttlMs, log = diagnostic, now = Date.now }) {
  /** @type {{key: string, until: number, value: T}|undefined} */
  let entry;
  /** @type {{key: string, promise: Promise<T>}|undefined} */
  let pending;
  let generation = 0;
  return {
    async get() {
      const key = context();
      if (entry?.key === key && now() < entry.until) {
        log({ role: 'wrapper', method: 'tools/list', cache: 'hit' });
        return structuredClone(entry.value);
      }
      log({ role: 'wrapper', method: 'tools/list', cache: 'miss' });
      if (pending?.key === key) return structuredClone(await pending.promise);
      const startedGeneration = generation;
      /** @type {{key: string, promise: Promise<T>}} */
      const current = { key, promise: Promise.resolve().then(load).then(value => {
        if (generation === startedGeneration && context() === key) entry = { key, until: now() + ttlMs, value: structuredClone(value) };
        return value;
      }).finally(() => { if (pending === current) pending = undefined; }) };
      pending = current;
      return structuredClone(await current.promise);
    },
    invalidate() { entry = undefined; generation++; },
    peek: () => entry?.value,
  };
}
