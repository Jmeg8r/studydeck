// WHAT: Holds the next render until a write in flight, and the state refresh after it, are done.
// WHY:  Recovery's writes outlive the view, so a learner can navigate before one lands. The
//       view they reach would be drawn from the state that write is about to replace.
//       Redrawing the open view when the refresh lands would throw away a quiz in progress,
//       so navigation waits instead, and never longer than WRITE_GATE_WAIT_MS: a write that
//       never answers must not freeze the cockpit.

export const WRITE_GATE_WAIT_MS = 5000;

export function createWriteGate({ waitMs = WRITE_GATE_WAIT_MS } = {}) {
  const pending = new Set();
  let latest = 0;
  return {
    /** Registers a write and hands it back unchanged. */
    track(write) {
      const entry = Promise.resolve(write).catch(() => {}).finally(() => pending.delete(entry));
      pending.add(entry);
      return write;
    },
    /** Resolves once every tracked write has finished, or the wait limit passes. Never rejects. */
    settled() {
      if (pending.size === 0) return Promise.resolve();
      let timer;
      const limit = new Promise((resolve) => { timer = setTimeout(resolve, waitMs); });
      return Promise.race([Promise.all(pending), limit]).finally(() => clearTimeout(timer));
    },
    /**
     * Runs render once the writes settle, unless a later navigation has asked since. Each
     * navigation waits on its own clock, so without this an earlier wait could expire after
     * a later render and redraw over whatever the learner typed in between.
     */
    async afterWrites(render) {
      const mine = ++latest;
      await this.settled();
      if (mine === latest) render();
    },
  };
}
