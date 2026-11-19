// WHAT: Piping a byte stream to an HTTP response without being able to crash the process.
// WHY: `.pipe()` does not forward errors. Every streamed route here called
//      `createReadStream(path).pipe(res)` with no error listener, and an unlistened
//      'error' event on a stream is an UNHANDLED event — it takes the whole cockpit down.
//      A file vanishing mid-download, an EIO on the external drive holding docs/, or Open
//      Notebook dropping an audio connection would each end the process for one bad
//      request. That is the failure this module exists to remove.
//
// Split into lib/ rather than left inline for the same reason lib/settlement.mjs was:
// the interesting behavior is a sequence of events, and a sequence is only testable if
// something can drive it.
import { createReadStream } from 'node:fs';

/**
 * Pipe `stream` to `res`, with both failure directions handled.
 *
 * Once the head is written there is no status left to send — a 500 cannot follow a 200 —
 * so a mid-stream failure destroys the response instead. The client sees a truncated
 * body, which is honest: the transfer really did fail. Pretending otherwise would mean
 * ending the response normally and handing over a silently short file.
 *
 * The reverse direction matters just as much: a client that closes the tab during a 46MB
 * video leaves the read stream open with nothing draining it, so `res.on('close')`
 * destroys the source. On a normal completion that is a no-op.
 */
export function pipeStream(res, stream, label) {
  stream.on('error', (err) => {
    console.error(`[stream] ${label} failed after headers were sent`, err);
    // `destroy()` with no argument, deliberately. Passing the error makes a generic
    // Writable re-emit it as its own 'error' event — which is another unlistened event,
    // i.e. the exact crash this function exists to prevent, moved one stream downstream.
    // The client sees a truncated body either way, and the cause is already logged.
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

/** `pipeStream` for a file on disk. `options` carries Range's start/end when slicing. */
export function pipeFile(res, path, options) {
  return pipeStream(res, createReadStream(path, options), path);
}
