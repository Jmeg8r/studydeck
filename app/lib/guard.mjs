// WHAT: The browser-side request boundary — the checks that binding 127.0.0.1 does not do.
// WHY: Assessment finding F8. Loopback binding stops other MACHINES; it does not stop other
//      TABS. Any page open in the same browser could issue a form-shaped cross-origin POST
//      to this port and cause a side effect. It cannot read the reply, but it does not need
//      to: rule 7 makes the attempt log the system of record, so an unauthorized WRITE is
//      already the damage — a forged attempt poisons the mastery figure every later
//      scheduling decision reads from. DNS rebinding is the second reason loopback is not
//      an identity: a hostile name that resolves to 127.0.0.1 reaches this server with the
//      browser believing it is same-origin with the attacker.
//
//      Deliberately NOT here: a CSRF token. `application/json` is not a CORS-safelisted
//      content type, so a cross-origin request carrying it is forced through a preflight,
//      and this server emits no Access-Control-Allow-* header on any response — so no
//      preflight can ever succeed and the real request is never sent. A token would guard a
//      gate nothing can pass, and it cannot help against the one caller that gets past all
//      of this (another process on the machine, which can simply read the token out of the
//      page). It would cost state threaded through every route and every fetch, and would
//      break the curl-driven verification this repo runs on.
//
// THE TAILNET DOOR (docs/changes/2026-11-09-tailnet-access): when config.tailnet is set, one
// more Host is admitted, the HTTPS name Tailscale Serve publishes on James's tailnet, and only
// with Tailscale-User-Login equal to the configured user. That header is believable because
// of rule 5's 127.0.0.1 bind: no other machine reaches this port, so a request carrying the
// tailnet Host can only have come through Serve, which sets the header from the tailnet's
// own login. Bind anywhere else and anyone on the network could forge it.
import { config, LOOPBACK_HOSTNAMES } from './config.mjs';

/** Methods that cannot change anything, and so only need the Host check. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Headers applied to EVERY response, set via `res.setHeader` at the top of the handler
 * rather than merged into each `writeHead` call.
 *
 * That placement is the point: a route added later, and the error path in the handler's
 * catch, both inherit these without anyone remembering to. Seven `writeHead` sites that
 * each had to spread a constant is seven chances to ship a response without one.
 *
 * `script-src 'self'` is the load-bearing directive, not frame-ancestors: the reading view
 * assigns rendered Open Notebook markdown to `innerHTML`, so a source document is an
 * injection sink. Blocking inline script and `javascript:` URLs is what makes a hostile
 * source inert. `style-src` keeps 'unsafe-inline' because the view layer sets `style`
 * attributes in 27 places — an honest weakening, and the narrow one: it permits CSS, not
 * execution.
 */
export const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", // the mind-map view previews a sketch as a data URL before upload
    "media-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};

/**
 * The hostname inside a `Host` header, without the port.
 *
 * Bracketed IPv6 (`[::1]:4310`) has to be split on the bracket — splitting on ':' would
 * return '[' and every IPv6 request would be refused as foreign.
 */
function hostname(hostHeader) {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  return hostHeader.split(':')[0];
}

function refuse(message) {
  return Object.assign(new Error(message), { status: 403 });
}

/**
 * Reject anything that reached this server without being the cockpit's own page.
 *
 * Throws with a `status`, so the handler's existing catch renders it — the same path every
 * other rejected request takes.
 */
export function assertBrowserBoundary(req) {
  const host = req.headers.host;
  if (!host) throw refuse('missing Host header');
  // Read per request, not captured at import, so the door's state is whatever config says
  // now; the tests open and close it that way.
  const tailnet = config.tailnet;
  const viaTailnet = Boolean(tailnet) && host.toLowerCase() === tailnet.host;
  if (!viaTailnet && !LOOPBACK_HOSTNAMES.has(hostname(host))) {
    // Reached over a name that is not this machine addressed literally — i.e. DNS, which
    // for a service bound to 127.0.0.1 means a rebind.
    throw refuse('this server answers only to a loopback Host');
  }
  // Every method, GET included: what the door protects is the learning record itself, and
  // reading it is as much the point as writing it. The refusal never names the expected user.
  if (viaTailnet && req.headers['tailscale-user-login'] !== tailnet.user) {
    throw refuse('this tailnet user is not allowed');
  }

  if (SAFE_METHODS.has(req.method)) return;

  // Origin is sent by browsers on EVERY non-GET/HEAD request, same-origin included, so on a
  // mutating route its absence means "not a browser" (curl, the test suite) rather than
  // "old client". Present-and-wrong is the cross-origin case, and `null` — what a sandboxed
  // iframe or a cross-origin redirect sends — fails the comparison like any other mismatch.
  const origin = req.headers.origin;
  const ownOrigin = viaTailnet ? tailnet.origin : `http://${host}`;
  if (origin !== undefined && origin !== ownOrigin) {
    throw refuse('cross-origin request refused');
  }

  // The CSRF gate. A <form> can only send urlencoded, multipart or text/plain; none of them
  // reach here, and the JSON that would has to clear a preflight this server never answers.
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw Object.assign(
      new Error('content-type must be application/json'),
      { status: 415 },
    );
  }
}
