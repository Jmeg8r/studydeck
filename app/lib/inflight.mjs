// WHAT: Collapse concurrent requests that carry the same mutation id into one run.
// WHY: The on-disk ledgers deduplicate a mutation only AFTER it has been recorded. A
//      submission whose work spans awaits — the walk debrief writes an Open Notebook note
//      and then spends ~15s drafting cards — has a window in between where a second
//      request finds no record and does the whole thing again. Disabling the button does
//      not close it: a reload or a second tab reaches the server just the same.
//
//      This is the in-process half of idempotency; the ledger is the durable half. Both
//      are needed, because a restart empties this map and only the ledger survives it.

/**
 * Run `factory()` once per key while it is in flight, sharing the result.
 *
 * Returns `{ result, shared }` — `shared: true` means this caller joined a run already
 * underway, which the route reports as a replay rather than as a fresh creation. The
 * entry is removed however the run settles, so a failure never wedges the key.
 */
export async function shareInFlight(map, key, factory) {
  const existing = map.get(key);
  if (existing) return { result: await existing, shared: true };

  const run = (async () => factory())().finally(() => map.delete(key));
  map.set(key, run);
  return { result: await run, shared: false };
}
