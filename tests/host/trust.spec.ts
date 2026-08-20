import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  assertTrustedAuthority,
  isLoopbackHostname,
  isTrustedRequest,
} from '../../src/host/trust.ts';

/** A request carrying just the headers the fence reads. */
function request(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('isLoopbackHostname', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]'])(
    'accepts %s',
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(true);
    },
  );

  it.each([
    'example.com',
    '10.0.0.1',
    '192.168.1.5',
    '1270.0.0.1',
    'localhost.evil.com',
  ])(
    'rejects %s',
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );
});

describe('assertTrustedAuthority', () => {
  it.each([
    'harness.internal',
    'harness.internal:3080',
    '10.0.0.5:8080',
    // WHATWG strips the default port; the entry is still a bare authority.
    'harness.internal:80',
    '[::1]',
    '[::1]:3080',
  ])('accepts the bare authority %s', (entry) => {
    expect(() => assertTrustedAuthority(entry)).not.toThrow();
  });

  it.each([
    ['a path', 'harness.internal/api'],
    ['a scheme', 'http://harness.internal'],
    ['credentials', 'user@harness.internal'],
    ['a dangling colon', 'harness.internal:'],
    ['a fragment', 'harness.internal#x'],
    ['a non-numeric port', 'harness.internal:http'],
    ['a query', 'harness.internal?a=b'],
    ['an empty entry', ''],
  ])('refuses %s at load time', (_label, entry) => {
    expect(() => assertTrustedAuthority(entry)).toThrow(/bare host/u);
  });
});

describe('isTrustedRequest', () => {
  it('accepts a loopback request', () => {
    expect(isTrustedRequest(request({ host: '127.0.0.1:3080' }), [])).toBe(
      true,
    );
    expect(isTrustedRequest(request({ host: 'localhost:3080' }), [])).toBe(
      true,
    );
  });

  it('accepts a Host on the default port, which normalization strips', () => {
    expect(isTrustedRequest(request({ host: 'localhost:80' }), [])).toBe(true);
    expect(
      isTrustedRequest(request({ host: 'harness.internal:80' }), [
        'harness.internal:80',
      ]),
    ).toBe(true);
  });

  it('matches an entry against the request modulo the default port', () => {
    expect(
      isTrustedRequest(request({ host: 'harness.internal' }), [
        'harness.internal:80',
      ]),
    ).toBe(true);
  });

  it('refuses a request with no Host at all', () => {
    expect(isTrustedRequest(request({}), [])).toBe(false);
  });

  it('refuses a rebound hostname that resolves to this machine', () => {
    expect(isTrustedRequest(request({ host: 'rebind.attacker.test:3080' }), []))
      .toBe(false);
  });

  it('accepts a declared authority', () => {
    expect(
      isTrustedRequest(request({ host: 'harness.internal:3080' }), [
        'harness.internal:3080',
      ]),
    ).toBe(true);
  });

  it('treats a port-less entry as any port, and a ported entry as exact', () => {
    expect(
      isTrustedRequest(request({ host: 'harness.internal:9999' }), [
        'harness.internal',
      ]),
    ).toBe(true);
    expect(
      isTrustedRequest(request({ host: 'harness.internal:9999' }), [
        'harness.internal:3080',
      ]),
    ).toBe(false);
  });

  it('ignores a malformed configured entry rather than trusting its prefix', () => {
    expect(
      isTrustedRequest(request({ host: 'harness.internal:3080' }), [
        'harness.internal/path',
      ]),
    ).toBe(false);
  });

  it('requires a stated Origin to be the same authority', () => {
    expect(
      isTrustedRequest(
        request({ host: 'localhost:3080', origin: 'http://localhost:3080' }),
        [],
      ),
    ).toBe(true);
    expect(
      isTrustedRequest(
        request({ host: 'localhost:3080', origin: 'http://evil.test' }),
        [],
      ),
    ).toBe(false);
  });

  it('accepts a non-loopback host with a matching Origin, as a phone on the LAN', () => {
    expect(
      isTrustedRequest(
        request({
          host: '192.168.1.50:3080',
          origin: 'http://192.168.1.50:3080',
        }),
        [],
      ),
    ).toBe(true);
  });

  it('refuses a non-loopback host whose Origin does not match', () => {
    expect(
      isTrustedRequest(
        request({ host: '192.168.1.50:3080', origin: 'http://evil.test' }),
        [],
      ),
    ).toBe(false);
  });

  it('accepts a same-origin GET with no Origin, as the state read on a phone', () => {
    expect(
      isTrustedRequest(
        request({ host: '192.168.1.50:3080', 'sec-fetch-site': 'same-origin' }),
        [],
      ),
    ).toBe(true);
  });

  it('accepts an opaque origin, which carries no authority to compare', () => {
    expect(
      isTrustedRequest(request({ host: 'localhost:3080', origin: 'null' }), []),
    ).toBe(true);
  });

  it('refuses a malformed Origin', () => {
    expect(
      isTrustedRequest(
        request({ host: 'localhost:3080', origin: 'not a url' }),
        [],
      ),
    ).toBe(false);
  });

  it('refuses an explicit cross-site request even on loopback', () => {
    expect(
      isTrustedRequest(
        request({ host: 'localhost:3080', 'sec-fetch-site': 'cross-site' }),
        [],
      ),
    ).toBe(false);
    expect(
      isTrustedRequest(
        request({ host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }),
        [],
      ),
    ).toBe(true);
  });

  it('reads a repeated header as its first value', () => {
    expect(
      isTrustedRequest(
        request({ host: 'localhost:3080', origin: ['http://evil.test'] }),
        [],
      ),
    ).toBe(false);
  });
});
