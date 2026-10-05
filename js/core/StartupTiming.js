// StartupTiming.js — records how long each startup phase takes (performance.now()) so slow starts can be
// diagnosed: boot phases (page load, Three.js import, textures, sounds, session check, world list…) and the
// Play phases (world row, chunk download + decode, spawn generation). Printed with ?debuglog and available
// as `crafton.timing.summary()`.

export class StartupTiming {
  constructor() {
    /** @type {{ name: string, group: string, start: number|null, end: number|null, ms: number|null, info: string }[]} */
    this.phases = [];
  }

  /** Begin a phase; finish it with end(). */
  start(name, group = 'boot') {
    const phase = { name, group, start: performance.now(), end: null, ms: null, info: '' };
    this.phases.push(phase);
    return phase;
  }

  end(phase, info = '') {
    if (!phase || phase.end !== null) return 0;
    phase.end = performance.now();
    phase.ms = phase.end - phase.start;
    if (info) phase.info = String(info);
    return phase.ms;
  }

  /** Record a duration measured elsewhere (resource timing, navigation start → now). */
  add(name, ms, info = '', group = 'boot') {
    const phase = { name, group, start: null, end: null, ms, info: String(info || '') };
    this.phases.push(phase);
    return phase;
  }

  /** Time an async function as one phase. */
  async measure(name, fn, group = 'boot') {
    const phase = this.start(name, group);
    try { return await fn(phase); } finally { this.end(phase); }
  }

  /** [{ name, ms, info }] for one group (finished phases only). */
  summary(group = 'boot') {
    return this.phases.filter((p) => p.group === group && p.ms !== null).map((p) => ({ name: p.name, ms: Math.round(p.ms), info: p.info }));
  }

  /** One console line per group, e.g. "CRAFTON timing boot: textures + atlas 180 ms (120 tiles) | …". */
  report(group = 'boot') {
    const parts = this.summary(group).map((p) => `${p.name} ${p.ms} ms${p.info ? ` (${p.info})` : ''}`);
    console.log(`CRAFTON timing ${group}: ${parts.join(' | ')}`);
    return parts;
  }
}
