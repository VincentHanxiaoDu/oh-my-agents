// Canonicalising a peer address, because criterion 6 is decided here.
//
// "Joining a host that is already joined does not create a duplicate entry or a duplicated agent
// list." The obvious implementation — compare the strings the user typed — fails that criterion the
// first time somebody types `http://100.64.0.2:8787/` after having typed `100.64.0.2`. So the
// comparison is on a CANONICAL FORM, and the canonical form is computed here, once.
//
// It deliberately does NOT resolve DNS. Resolution is a network operation whose answer changes, and
// a join record that means something different after a DHCP lease expires is not durable. Two
// different names for one machine are instead collapsed later, by `hostId`, once the peer has
// actually answered — see `peers.ts`.

export const DEFAULT_PEER_PORT = 8787;

export interface PeerAddress {
  /** Lowercased host or IP literal, without brackets. */
  host: string;
  port: number;
  /** The form used for comparison, for display, and as a record key. */
  canonical: string;
}

export type ParseResult = { kind: 'ok'; address: PeerAddress } | { kind: 'invalid'; reason: string };

/**
 * Accepts `host`, `host:port`, `[v6]`, `[v6]:port`, and any of those with an `http://` or
 * `https://` prefix and a trailing slash. Rejects everything else rather than guessing.
 */
export function parsePeerAddress(input: string): ParseResult {
  const raw = input.trim();
  if (raw === '') return { kind: 'invalid', reason: 'an empty string is not an address' };

  let rest = raw;
  if (/^https?:\/\//i.test(rest)) {
    let url: URL;
    try {
      url = new URL(rest);
    } catch {
      return { kind: 'invalid', reason: `'${raw}' looks like a URL and is not one` };
    }
    if (url.pathname !== '/' && url.pathname !== '') {
      return { kind: 'invalid', reason: `'${raw}' names a path; a peer is a host and a port, not a path` };
    }
    // `url.hostname` already strips the brackets from a v6 literal and lowercases the host.
    rest = url.port === '' ? url.hostname : `${bracketIfV6(url.hostname)}:${url.port}`;
  }

  let host: string;
  let portText: string | undefined;

  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close === -1) return { kind: 'invalid', reason: `'${raw}' opens a bracket it never closes` };
    host = rest.slice(1, close);
    const after = rest.slice(close + 1);
    if (after !== '') {
      if (!after.startsWith(':')) return { kind: 'invalid', reason: `'${raw}' has something other than a port after the address` };
      portText = after.slice(1);
    }
  } else {
    const colons = rest.split(':').length - 1;
    if (colons > 1) {
      // A bare IPv6 literal. Unambiguous only because it has no port; `::1:8787` is genuinely
      // ambiguous and is read as an address, which is what the brackets exist to disambiguate.
      host = rest;
    } else if (colons === 1) {
      const at = rest.lastIndexOf(':');
      host = rest.slice(0, at);
      portText = rest.slice(at + 1);
    } else {
      host = rest;
    }
  }

  host = host.trim().toLowerCase();
  if (host === '') return { kind: 'invalid', reason: `'${raw}' names no host` };
  if (/[\s/?#@]/.test(host)) return { kind: 'invalid', reason: `'${raw}' is not a host name or an IP address` };

  let port = DEFAULT_PEER_PORT;
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) return { kind: 'invalid', reason: `'${portText}' is not a port number` };
    port = Number(portText);
    if (port < 1 || port > 65535) return { kind: 'invalid', reason: `'${portText}' is not a port number between 1 and 65535` };
  }

  return { kind: 'ok', address: { host, port, canonical: `${bracketIfV6(host)}:${port}` } };
}

/** How this address appears in a URL. IPv6 needs the brackets back. */
export function bracketIfV6(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function peerOrigin(address: PeerAddress): string {
  return `http://${bracketIfV6(address.host)}:${address.port}`;
}
