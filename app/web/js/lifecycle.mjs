// WHAT: Small cancellation primitives for browser views.
// WHY: Clearing a view's DOM does not stop a timer or fetch it started. Views own an
//      AbortController and return its abort function to main.mjs on navigation.

function abortError() {
  return new DOMException('view was replaced', 'AbortError');
}

/** A timeout that settles immediately when its view is cleaned up. */
export function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms, resolve);
    const onAbort = () => done(reject, abortError());
    function done(settle, value) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle(value);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isAbortError(err) {
  return err?.name === 'AbortError';
}

/** One owner for a view's requests, child renderers and global listeners. */
export function createViewScope() {
  const controller = new AbortController();
  const cleanups = new Set();
  return {
    signal: controller.signal,
    own(cleanup) {
      if (controller.signal.aborted) cleanup();
      else cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    },
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort();
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    },
  };
}
