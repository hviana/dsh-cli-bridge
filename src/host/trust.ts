/**
 * The channel's reachability fence.
 *
 * The channel is same-origin with the web UI. A browser request is accepted
 * exactly when the Origin it states matches the Host the user actually loaded,
 * which is how the panel works from loopback AND from a LAN address on a phone.
 * A request with no browser Origin — a script or a health check — must come
 * from loopback or a host the operator has explicitly trusted. This is a
 * cross-site defense, NOT authentication: the harness has none yet, and a
 * plugin must not pretend otherwise.
 *
 * @module dsh-cli-bridge/host/trust
 */
import type { IncomingMessage } from 'node:http';

/** Hostnames that are always this machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]', '::1']);

/** IPv4 loopback range, `127.0.0.0/8`. */
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

/**
 * Whether a hostname names this machine.
 * @param hostname - a WHATWG-normalized hostname.
 * @returns true for loopback names and addresses.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(lowered) || LOOPBACK_IPV4.test(lowered);
}

/**
 * Parse an authority through WHATWG rules so both sides of a comparison are
 * normalized the same way — the property DNS rebinding cannot forge.
 * @param authority - a `host` or `host:port` string.
 * @returns the parsed URL, or `undefined` when the authority is not canonical.
 */
function parseAuthority(authority: string | undefined): URL | undefined {
  if (authority === undefined || authority.length === 0) return undefined;
  try {
    const url = new URL(`http://${authority}`);
    // Anything beyond an authority — a path, credentials, a query, a fragment —
    // means the string was not the bare authority it claimed to be. Comparing
    // the parsed `host` back to the input would be wrong here: WHATWG strips the
    // default port, so a legitimate `localhost:80` would read as malformed.
    const bare = url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      !authority.includes('/') &&
      !authority.includes('@') &&
      hasWellFormedPort(authority);
    return bare && url.host.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an authority's port, if it states one at all, is really a port.
 *
 * A dangling colon must not pass: WHATWG reads `harness.internal:` as the bare
 * hostname with no port, which this fence would then treat as an ANY-PORT
 * grant — silently broadening what the author wrote.
 * @param authority - the raw authority text.
 * @returns true when there is no port, or the port is digits.
 */
function hasWellFormedPort(authority: string): boolean {
  // An IPv6 literal carries colons of its own; only what follows its bracket
  // can be a port.
  const afterLiteral = authority.startsWith('[')
    ? authority.slice(authority.indexOf(']') + 1)
    : authority;
  const colon = afterLiteral.indexOf(':');
  return colon < 0 || /^\d+$/u.test(afterLiteral.slice(colon + 1));
}

/**
 * Validate a configured trusted authority at load time.
 *
 * A malformed entry would otherwise quietly authorize the hostname inside
 * something like `harness.internal/path`, or widen a dangling colon into an
 * any-port grant.
 * @param entry - the configured authority.
 * @throws {Error} when the entry is not a bare, canonical `host[:port]`.
 */
export function assertTrustedAuthority(entry: string): void {
  if (parseAuthority(entry) === undefined) {
    throw new Error(
      `cli-bridge: channel.trustedHosts entry ${
        JSON.stringify(entry)
      } is not a bare host[:port] authority`,
    );
  }
}

/**
 * Whether one request may reach the channel.
 * @param request - the incoming request.
 * @param trustedHosts - configured non-loopback authorities.
 * @returns true when the request passes the fence.
 */
export function isTrustedRequest(
  request: IncomingMessage,
  trustedHosts: readonly string[],
): boolean {
  const host = parseAuthority(request.headers.host);
  if (host === undefined) return false;

  // An explicit cross-site request is refused outright: the browser's own
  // marker for "this page did not originate here".
  const site = readHeader(request, 'sec-fetch-site');
  if (site === 'cross-site') return false;

  const origin = readHeader(request, 'origin');
  // A browser sends an Origin on same-origin POSTs, on the event stream, and on
  // any cross-origin request. When it does, the page's own authority is the
  // fence: the Origin must be the Host the user loaded. This is the cross-site
  // defense — a page on another site cannot forge a matching Origin — and it is
  // what lets the web UI be reached from a LAN address on a phone as well as
  // from loopback.
  if (origin !== undefined && origin !== 'null') {
    try {
      return new URL(origin).host === host.host;
    } catch {
      return false;
    }
  }

  // No exact Origin: a browser's plain same-origin GET (the state read) carries
  // none but marks itself same-origin, so accept that. Anything else — a script
  // or a health check — must come from loopback or an explicitly trusted host.
  if (site === 'same-origin') return true;
  return isLoopbackHostname(host.hostname) ||
    matchesTrusted(host, trustedHosts);
}

/** Whether a request authority matches one of the configured entries. */
function matchesTrusted(host: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const trusted = parseAuthority(entry);
    if (trusted === undefined) return false;
    // A port-less entry trusts the name on any port; an entry with a port is exact.
    return trusted.port === ''
      ? trusted.hostname === host.hostname
      : trusted.host === host.host;
  });
}

/** Read one header as a single string. */
function readHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
