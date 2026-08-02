// Pairing a device, listing devices, revoking one device (criteria 2, 3, 4, 5).
//
// Each operation is a single locked read-modify-write of the store, so "mark the code used" and
// "record the device" cannot come apart.

import { constantTimeEquals, issueCredential, type Credential } from './credential.js';
import { CODE_TTL_MS, findUsableCode, generateCode, hashCode } from './codes.js';
import { mutateStore, readStore, sha256Hex, type DeviceRecord } from './store.js';
import type { PathEnv } from '../paths.js';

export interface IssuedCode {
  /** Shown to a person once, never stored. */
  code: string;
  expiresAt: string;
}

export type Issue<T> = { kind: 'ok'; value: T } | { kind: 'undetermined'; reason: string };

/** Criterion 2: the host produces a one-time pairing code on demand. */
export function createPairingCode(env: PathEnv = process.env, now = Date.now()): Issue<IssuedCode> {
  const code = generateCode();
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  const result = mutateStore<IssuedCode>((store) => {
    // Used and expired codes are dropped on every write rather than accumulating: a store that
    // grows without bound is a store whose read time grows without bound, and the read is on the
    // request path.
    const codes = store.codes.filter((c) => c.usedAt === undefined && Date.parse(c.expiresAt) > now);
    codes.push({ codeHash: hashCode(code), createdAt: new Date(now).toISOString(), expiresAt });
    return { store: { ...store, codes }, value: { code, expiresAt } };
  }, env);
  return result.kind === 'ok' ? { kind: 'ok', value: result.value } : { kind: 'undetermined', reason: result.reason };
}

export type PairOutcome =
  /** Paired. The credential is returned once and is not recoverable afterwards. */
  | { kind: 'paired'; credential: Credential; device: DeviceRecord }
  /** Mistyped, already used, or expired — deliberately one outcome (criterion 3). */
  | { kind: 'refused' }
  /** The store could not be read or written. NOT a refusal, and never rendered as one. */
  | { kind: 'undetermined'; reason: string };

/** Criterion 2 and 3: redeem a code exactly once, within its window. */
export function pairDevice(presentedCode: string, label: string, env: PathEnv = process.env, now = Date.now()): PairOutcome {
  const result = mutateStore<PairOutcome>((store) => {
    const verdict = findUsableCode(store.codes, presentedCode, now);
    if (verdict.kind === 'refused') {
      // The store is still written back: the pruning below happens whether or not the code was
      // good, so a wrong guess and a right one do the same amount of work on disk.
      const codes = store.codes.filter((c) => c.usedAt === undefined && Date.parse(c.expiresAt) > now);
      return { store: { ...store, codes }, value: { kind: 'refused' } };
    }

    const credential = issueCredential(store.meshSecret);
    const device: DeviceRecord = {
      id: credential.deviceId,
      label,
      pairedAt: new Date(now).toISOString(),
      macHash: sha256Hex(credential.mac),
    };
    const codes = store.codes.map((c, i) =>
      i === verdict.index ? { ...c, usedAt: new Date(now).toISOString(), usedByDeviceId: device.id } : c,
    );
    return {
      store: { ...store, codes, devices: [...store.devices, device] },
      value: { kind: 'paired', credential, device },
    };
  }, env);

  if (result.kind === 'undetermined') return { kind: 'undetermined', reason: result.reason };
  return result.value;
}

export type ListOutcome =
  | { kind: 'present'; devices: DeviceRecord[] }
  | { kind: 'absent' }
  | { kind: 'undetermined'; reason: string };

/** Criterion 4: paired devices are listable. Revoked ones are shown too, marked. */
export function listDevices(env: PathEnv = process.env): ListOutcome {
  const read = readStore(env);
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'undetermined') return { kind: 'undetermined', reason: read.reason };
  return { kind: 'present', devices: read.store.devices };
}

export type RevokeOutcome =
  | { kind: 'revoked'; device: DeviceRecord }
  | { kind: 'already-revoked'; device: DeviceRecord }
  | { kind: 'no-such-device' }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'undetermined'; reason: string };

/**
 * Criterion 4 and 5: revoke ONE device.
 *
 * Accepts a full id or an unambiguous prefix, because the id is 32 hex characters and the thing a
 * person is holding is a phone, not a clipboard. An ambiguous prefix revokes NOTHING and says so —
 * revoking the first match would be the single worst behaviour available here.
 */
export function revokeDevice(idOrPrefix: string, env: PathEnv = process.env, now = Date.now()): RevokeOutcome {
  const needle = idOrPrefix.trim().toLowerCase();
  if (needle.length < 4) return { kind: 'no-such-device' };

  const result = mutateStore<RevokeOutcome>((store) => {
    const matches = store.devices.filter((d) => d.id === needle || d.id.startsWith(needle));
    if (matches.length === 0) return { store, value: { kind: 'no-such-device' } };
    if (matches.length > 1) return { store, value: { kind: 'ambiguous', matches: matches.map((d) => d.id) } };
    const target = matches[0]!;
    if (target.revokedAt !== undefined) return { store, value: { kind: 'already-revoked', device: target } };
    const revoked: DeviceRecord = { ...target, revokedAt: new Date(now).toISOString() };
    // Every OTHER device is copied through untouched — criterion 5 in one line. Rebuilding the
    // list from anything but the existing records is how "revoke one" becomes "revoke all but one".
    const devices = store.devices.map((d) => (d.id === target.id ? revoked : d));
    return { store: { ...store, devices }, value: { kind: 'revoked', device: revoked } };
  }, env);

  if (result.kind === 'undetermined') return { kind: 'undetermined', reason: result.reason };
  return result.value;
}

/**
 * Something a human can use to tell two devices apart (criterion 4).
 *
 * Derived from the User-Agent, which is the only thing a browser volunteers that is about the
 * device. It is a HINT and is labelled as one wherever it is shown: a User-Agent is attacker-
 * controlled, so this is never used to make a decision, only to help a person recognise a row.
 * Truncated hard, because a User-Agent is arbitrary-length attacker-controlled text and the store
 * is on the request path.
 */
export function labelFromUserAgent(ua: string | undefined): string {
  const raw = (ua ?? '').slice(0, 400);
  const platform =
    /\biPhone\b/.test(raw) ? 'iPhone'
    : /\biPad\b/.test(raw) ? 'iPad'
    : /\bAndroid\b/.test(raw) ? 'Android'
    : /\bMac OS X\b|\bMacintosh\b/.test(raw) ? 'Mac'
    : /\bWindows\b/.test(raw) ? 'Windows'
    : /\bLinux\b/.test(raw) ? 'Linux'
    : 'unknown device';
  const browser =
    /\bEdg\//.test(raw) ? 'Edge'
    : /\bFirefox\//.test(raw) ? 'Firefox'
    : /\bChrome\//.test(raw) || /\bCriOS\//.test(raw) ? 'Chrome'
    : /\bSafari\//.test(raw) ? 'Safari'
    : 'unknown browser';
  return `${platform} · ${browser}`;
}

/** Only used by the tests that assert a revoked device's record is otherwise untouched. */
export function sameExceptRevocation(a: DeviceRecord, b: DeviceRecord): boolean {
  return (
    constantTimeEquals(a.id, b.id) &&
    a.label === b.label &&
    a.pairedAt === b.pairedAt &&
    constantTimeEquals(a.macHash, b.macHash)
  );
}
