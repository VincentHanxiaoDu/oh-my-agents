// Test doubles for the request path, and an isolated state directory.
//
// Not a test file: `npm test` runs `dist/test/*.test.js`, so nothing here is collected as a suite.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A fresh, empty state directory. `OMA_STATE_DIR` is the documented override in src/paths.ts. */
export function tempEnv(): { OMA_STATE_DIR: string } {
  return { OMA_STATE_DIR: mkdtempSync(path.join(tmpdir(), 'oma-pair-')) };
}

export interface CapturedResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  /** The response as bytes on the wire, near enough for a byte-equality assertion. */
  wire(): string;
}

export function fakeResponse(): ServerResponse & { captured: CapturedResponse } {
  const captured: CapturedResponse = {
    status: 0,
    headers: {},
    body: '',
    wire(): string {
      const names = Object.keys(captured.headers).sort();
      return (
        `${captured.status}\n` +
        names.map((n) => `${n.toLowerCase()}: ${String(captured.headers[n])}`).join('\n') +
        `\n\n${captured.body}`
      );
    },
  };
  const res = {
    captured,
    headersSent: false,
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      captured.status = code;
      captured.headers = { ...(headers ?? {}) };
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') captured.body += chunk;
      else if (Buffer.isBuffer(chunk)) captured.body += chunk.toString('utf8');
      return res;
    },
  };
  return res as unknown as ServerResponse & { captured: CapturedResponse };
}

export function fakeRequest(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const stream = Readable.from([Buffer.from(opts.body ?? '')]) as unknown as IncomingMessage;
  stream.method = opts.method ?? 'GET';
  stream.url = opts.url ?? '/';
  stream.headers = { ...(opts.headers ?? {}) };
  return stream;
}
