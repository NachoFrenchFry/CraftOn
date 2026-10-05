// WorldLock.js — one open tab per world. A localStorage entry per world holds the owning tab id and a
// heartbeat timestamp; a second tab refuses to open the world while the heartbeat is fresh.

const HEARTBEAT_MS = 5000;
const STALE_MS = 15000;
const TAB_ID = (() => {
  try {
    let id = sessionStorage.getItem('crafton.tabId');
    if (!id) { id = Math.random().toString(36).slice(2); sessionStorage.setItem('crafton.tabId', id); }
    return id;
  } catch (e) { return Math.random().toString(36).slice(2); }
})();

export class WorldLock {
  /** @param {string} [tabId] override for tests; defaults to this tab's id */
  constructor(worldId, tabId = TAB_ID) {
    this.key = 'crafton.worldlock.' + worldId;
    this.tab = tabId;
    this.timer = null;
  }

  _read() { try { return JSON.parse(localStorage.getItem(this.key) || 'null'); } catch (e) { return null; } }
  _write() { try { localStorage.setItem(this.key, JSON.stringify({ tab: this.tab, t: Date.now() })); } catch (e) { /* ignore */ } }

  /** @returns {boolean} false when another tab holds a fresh lock */
  acquire() {
    const cur = this._read();
    if (cur && cur.tab !== this.tab && Date.now() - cur.t < STALE_MS) return false;
    this._write();
    this.timer = setInterval(() => this._write(), HEARTBEAT_MS);
    return true;
  }

  release() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const cur = this._read();
    if (!cur || cur.tab === this.tab) { try { localStorage.removeItem(this.key); } catch (e) { /* ignore */ } }
  }
}
