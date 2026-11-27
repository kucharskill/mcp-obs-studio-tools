import { diagnostic } from './diagnostics.js';

/** Session-bound or interactive results must be executed again, never field-stripped.
 * @param {unknown} result */
export function reusableDiscovery(result) {
  if (!result || typeof result !== 'object') return true;
  for (const [key, value] of Object.entries(result)) {
    if (['sessionId', 'subscriptionId', 'progressToken', 'taskId', 'task'].includes(key)) return false;
    if (key === 'resultType' && ['input_required', 'not_modified'].includes(value)) return false;
    if (key === '_meta' && !reusableDiscovery(value)) return false;
  }
  return true;
}

/** Metadata cache. Shared-store hits never contact or keep alive a worker.
 * @template T
 * @param {{load: () => Promise<T>, context: () => string, ttlMs: number, reusable?: (value: T) => boolean, store?: {read: (context: string) => Promise<any>, write: (entry: {key: string, until: number, value: T}) => Promise<void>, remove: () => Promise<void>}, log?: typeof diagnostic, now?: () => number}} options
 */
export function createDiscoveryCache({ load, context, ttlMs, reusable = () => true, store, log = diagnostic, now = Date.now }) {
  /** @type {{key: string, until: number, value: T}|undefined} */
  let entry;
  /** @type {{key: string, promise: Promise<T>}|undefined} */
  let pending;
  let generation = 0;
  let persistence = Promise.resolve();
  /** Serialize local writes/removals so an invalidated in-flight refresh cannot restore stale metadata.
   * @param {() => Promise<void>} action */
  const persist = (action) => {
    persistence = persistence.then(action).catch(() => { log({ role: 'wrapper', method: 'tools/list', reason: 'cache-storage-unavailable' }); });
    return persistence;
  };
  return {
    async get() {
      const key = context();
      if (store) {
        await persistence;
        const readingGeneration = generation;
        // Read through on every lookup so invalidation by another replica is visible.
        const record = await store.read(key);
        entry = record && reusable(record.value) && generation === readingGeneration ? { key, until: record.until, value: record.value } : undefined;
      }
      if (entry?.key === key && now() < entry.until) {
        log({ role: 'wrapper', method: 'tools/list', cache: 'hit' });
        return structuredClone(entry.value);
      }
      log({ role: 'wrapper', method: 'tools/list', cache: 'miss' });
      if (pending?.key === key) return structuredClone(await pending.promise);
      const startedGeneration = generation;
      /** @type {{key: string, promise: Promise<T>}} */
      const current = { key, promise: Promise.resolve().then(load).then(async value => {
        if (generation === startedGeneration && context() === key && reusable(value)) {
          entry = { key, until: now() + ttlMs, value: structuredClone(value) };
          const completed = entry;
          if (store && ttlMs > 0) await persist(async () => { if (generation === startedGeneration) await store.write(completed); });
        }
        return value;
      }).finally(() => { if (pending === current) pending = undefined; }) };
      pending = current;
      return structuredClone(await current.promise);
    },
    async invalidate() { entry = undefined; generation++; if (store) await persist(() => store.remove()); },
    peek: () => entry?.value,
  };
}
