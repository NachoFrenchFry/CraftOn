// SoundBank.js — the sounds as real files: audio/manifest.json maps each sound id ("breaking/stone", "mobs/cow/hurt"…)
// to one file (audio/<id>.<ext>) plus its base volume, how much the pitch and the volume may vary per play and whether it
// loops; the bank fetches every file with `cache: 'reload'` (an edited file shows up after a plain reload, like the
// textures), decodes it with an OfflineAudioContext (no user gesture needed, so loading starts at boot) and keeps one
// AudioBuffer per sound. Common sounds load first and nothing ever blocks the menu: a sound whose buffer is not there
// yet is skipped. A missing or broken file leaves that sound silent and is reported in one grouped console warning.
// The synthesis the shipped files were rendered from lives in tools/sound-recipes/ and is never imported by the game.

/** What plays first in a session loads first (id prefixes, in order). */
const PRIORITY = ['ui/click', 'ui/hover', 'walking/', 'breaking/', 'placing/', 'mining/', 'player/', 'items/', 'ui/', 'ambient/wind', 'mobs/', 'liquids/', 'ambient/'];
const BATCH = 4;

export class SoundBank {
  constructor(baseUrl = 'audio/') {
    this.baseUrl = baseUrl;
    /** id → { file, volume, pitch, volumeVar, loop } from the manifest. */
    this.manifest = new Map();
    /** id → AudioBuffer. */
    this.buffers = new Map();
    this.ready = false;
    /** The background loading promise (resolves with the number of sounds); `rendered` / `total` track progress for F3 / tests. */
    this.rendering = null;
    this.total = 0;
    this.rendered = 0;
    /** [id, reason] of sounds that could not be loaded. */
    this.failed = [];
    this.manifestError = null;
    this._decoder = null;
  }

  _decoderCtx() {
    if (!this._decoder) this._decoder = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
    return this._decoder;
  }

  /** Fetch the manifest, then every file in priority order (idempotent). Resolves with the number of sounds. */
  renderInBackground() {
    if (this.rendering) return this.rendering;
    this.rendering = this._load();
    return this.rendering;
  }

  async _load() {
    try {
      const res = await fetch(this.baseUrl + 'manifest.json', { cache: 'reload' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      for (const [id, e] of Object.entries(json.sounds || {})) {
        const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
        this.manifest.set(id, { file: typeof e.file === 'string' ? e.file : '', volume: num(e.volume, 1), pitch: Math.max(0, num(e.pitch, 0)), volumeVar: Math.max(0, num(e.volumeVar, 0)), loop: !!e.loop });
      }
    } catch (e) {
      this.manifestError = String(e && e.message || e);
      console.warn(`SoundBank: audio/manifest.json could not be loaded (${this.manifestError}); the game stays silent. Run python3 tools/update_audio_manifest.py after adding sound files.`);
      this.ready = true;
      return 0;
    }
    const rank = (id) => { const i = PRIORITY.findIndex((p) => id.startsWith(p)); return i < 0 ? PRIORITY.length : i; };
    const ids = [...this.manifest.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
    this.total = ids.length;
    for (let i = 0; i < ids.length; i += BATCH) {
      await Promise.all(ids.slice(i, i + BATCH).map((id) => this._loadSound(id)));
      await new Promise((r) => setTimeout(r, 0)); // keep the menu responsive
    }
    this.ready = true;
    this._report();
    return this.total;
  }

  /** audio/<folders of the id>/<file>: "mobs/cow/hurt" + "hurt.wav" → audio/mobs/cow/hurt.wav. */
  urlOf(id) {
    const entry = this.manifest.get(id);
    if (!entry || !entry.file) return null;
    const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/') + 1) : '';
    return `${this.baseUrl}${dir}${entry.file}`;
  }

  async _loadSound(id) {
    const url = this.urlOf(id);
    try {
      if (!url) throw new Error('no file in the manifest');
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      this.buffers.set(id, await this._decoderCtx().decodeAudioData(bytes));
    } catch (e) {
      this.failed.push([id, String(e && e.message || e)]);
    }
    this.rendered++;
  }

  _report() {
    if (!this.failed.length) return;
    const lines = this.failed.slice(0, 40).map(([what, why]) => `  ${what}: ${why}`);
    console.warn(`SoundBank: ${this.failed.length} sound(s) could not be loaded (they stay silent; .wav or .mp3 play everywhere, Safari skips some .ogg):\n${lines.join('\n')}${this.failed.length > 40 ? '\n  …' : ''}`);
  }

  has(id) { return this.buffers.has(id); }

  /** The sound's buffer, or null while it is not loaded (the caller stays silent). */
  get(id) { return this.buffers.get(id) || null; }

  /** The manifest fields of a sound (defaults when unknown). */
  volumeOf(id) { const e = this.manifest.get(id); return e ? e.volume : 1; }
  pitchOf(id) { const e = this.manifest.get(id); return e ? e.pitch : 0; }
  volumeVarOf(id) { const e = this.manifest.get(id); return e ? e.volumeVar : 0; }
  isLoop(id) { const e = this.manifest.get(id); return !!e && e.loop; }
}
