// The startup banner (criterion 2 and criterion 4).
//
// CRITERION 4 IS A CONSTRAINT ON THIS FILE SPECIFICALLY: the loopback-only case and the tailnet
// case must be distinguishable FROM THE STARTUP OUTPUT ALONE. So the banner carries a machine-
// readable marker line — `REACHABILITY: tailnet` or `REACHABILITY: local-only` — as well as prose,
// and the test asserts on the marker. Prose that a later edit softens is not a guarantee; a marker
// a test reads is.
//
// The third case gets its own line. A host that could not determine whether Tailscale is here says
// `DETERMINATION: undetermined` and states the question it could not answer. It must never print
// "Tailscale is not installed" on the strength of a probe that timed out.

import type { BindPlan } from './bind.js';

export interface BannerInput {
  plan: BindPlan;
  port: number;
  pid: number;
}

/** The address to put in front of a person: the one that works from another device, if there is one. */
export function primaryUrl(plan: BindPlan, port: number): string {
  const host = plan.reachability === 'tailnet' ? plan.tailnet[0]! : plan.loopback[0]!;
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `http://${bracketed}:${port}/`;
}

export function renderBanner(input: BannerInput): string {
  const { plan, port, pid } = input;
  const lines: string[] = [];

  lines.push('oh-my-agents host is serving.');
  lines.push('');
  lines.push(`REACHABILITY: ${plan.reachability}`);
  lines.push(`DETERMINATION: ${plan.determination}`);
  lines.push('');

  if (plan.reachability === 'tailnet') {
    lines.push('Reachable from any device on your tailnet. Open this address there:');
    lines.push('');
    lines.push(`    ${primaryUrl(plan, port)}`);
    lines.push('');
    lines.push(`On this machine:  ${urlFor(plan.loopback[0]!, port)}`);
    lines.push('Nothing is published to the public internet, and this host is not on your LAN.');
  } else if (plan.determination === 'undetermined') {
    lines.push('LOCAL ACCESS ONLY — and this host COULD NOT DETERMINE whether Tailscale is available.');
    lines.push('This is not the same as saying Tailscale is absent. It is saying the question was not');
    lines.push('answered, so no tailnet address was bound.');
    lines.push('');
    lines.push(`    ${primaryUrl(plan, port)}   (this machine only)`);
    lines.push('');
    lines.push(`Could not determine because: ${plan.reason}`);
  } else {
    lines.push('LOCAL ACCESS ONLY — no other device can reach this host.');
    lines.push('');
    lines.push(`    ${primaryUrl(plan, port)}   (this machine only)`);
    lines.push('');
    lines.push(`No tailnet address, because: ${plan.reason}`);
    lines.push('Bring your tailnet up and start the host again to serve it to your other devices.');
  }

  if (plan.rejected.length > 0) {
    lines.push('');
    lines.push('Addresses this host refused to bind:');
    for (const r of plan.rejected) lines.push(`  - ${r.address}: ${r.reason}`);
  }

  lines.push('');
  lines.push(`Listening on: ${plan.addresses.map((a) => `${a}:${port}`).join('  ')}`);
  lines.push(`pid ${pid} — this host has left your terminal; closing it will not stop it.`);
  lines.push('Check on it with:  oh-my-agents status      Stop it with:  oh-my-agents stop');

  return lines.join('\n');
}

function urlFor(host: string, port: number): string {
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `http://${bracketed}:${port}/`;
}
