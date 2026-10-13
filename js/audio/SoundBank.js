// SoundBank.js — the sounds as real files (Update #15): audio/manifest.json maps each sound id ("breaking/stone",
// "mobs/cow/hurt"…) to its numbered variation files and a volume; the bank fetches them with `cache: 'reload'` (an
// edited file shows up after a plain reload, like the textures), decodes them with an OfflineAudioContext (no user
// gesture needed, so loading starts at boot) and keeps one AudioBuffer per variation. Common sounds load first and
// nothing ever blocks the menu: a sound whose buffers are not there yet is skipped. Missing or broken files leave that
// sound silent and are reported in one grouped console warning. The synthesis that used to render these lives in
// tools/sound-recipes/ (the export tool) and is never imported by the game.

/** What plays first in a session loads first (id prefixes, in order). */
const PRIORITY = ['ui/click', 'ui/hover', 'walking/', 'breaking/', 'placing/', 'mining/', 'player/', 'items/', 'ui/', 'ambient/wind', 'mobs/', 'liquids/', 'ambient/'];
const BATCH = 4;

export class SoundBank {
  constructor(baseUrl = 'audio/') {
    this.baseUrl = baseUrl;
    /** id → { files, volume, loop } from the manifest. */
    this.manifest = new Map();
    /** id → AudioBuffer[] (the decoded variations). */
    this.buffers = new Map();
    this.ready = false;
    /** The background loading promise (resolves with the number of sounds); `rendered` / `total` track progress for F3 / tests. */
    this.rendering = null;
    this.total = 0;
    this.rendered = 0;
    /** [id, reason] of sounds that could not be loaded at all, and [id/file, reason] of single files that failed. */
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
      for (const [id, entry] of Object.entries(json.sounds || {})) {
        this.manifest.set(id, { files: Array.isArray(entry.files) ? entry.files : [], volume: typeof entry.volume === 'number' ? entry.volume : 1, loop: !!entry.loop });
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

  async _loadSound(id) {
    const entry = this.manifest.get(id);
    const list = [];
    if (!entry.files.length) this.failed.push([id, 'no files in audio/' + id + '/']);
    for (const file of entry.files) {
      try {
        const res = await fetch(`${this.baseUrl}${id}/${file}`, { cache: 'reload' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        const buffer = await this._decoderCtx().decodeAudioData(bytes);
        list.push(buffer);
      } catch (e) {
        this.failed.push([`${id}/${file}`, String(e && e.message || e)]);
      }
    }
    if (list.length) this.buffers.set(id, list);
    this.rendered++;
  }

  _report() {
    if (!this.failed.length) return;
    const lines = this.failed.slice(0, 40).map(([what, why]) => `  ${what}: ${why}`);
    console.warn(`SoundBank: ${this.failed.length} sound file(s) could not be loaded (those sounds stay silent; .wav or .mp3 play everywhere, Safari skips some .ogg):\n${lines.join('\n')}${this.failed.length > 40 ? '\n  …' : ''}`);
  }

  has(id) { const l = this.buffers.get(id); return !!l && l.length > 0; }

  /** A random variation of a sound, or null while it is not loaded (the caller stays silent). */
  get(id, rng = Math.random) {
    const list = this.buffers.get(id);
    if (!list || !list.length) return null;
    return list[Math.floor(rng() * list.length)];
  }

  /** The manifest volume of a sound (1 when unknown). */
  volumeOf(id) { const e = this.manifest.get(id); return e ? e.volume : 1; }
  isLoop(id) { const e = this.manifest.get(id); return !!e && e.loop; }
}
