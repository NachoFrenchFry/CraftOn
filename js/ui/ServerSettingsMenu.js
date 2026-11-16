// ServerSettingsMenu.js — the pause menu's "World Settings…" (single player) / "Server Settings…" (hosting) screen: the
// world type as read-only text (it can never change: chunks are rebuilt from the seed), the player's own game mode and the
// game mode for other players (both also in single player), and the world toggles — PvP (hosting only), Fall damage,
// Natural mob spawning, Hostile mobs (disabled while natural spawning is off), Keep inventory on death, Explosives,
// Explosions break blocks and Same Wi-Fi multiplayer. Every change is saved in the world (meta.<key>) and reaches
// connected guests at once (WELCOME / Msg.WORLD); Same Wi-Fi multiplayer opens or closes the world to the network at once.
// While hosting the screen also lists every player (connected first, with the connection type and ping) with a mode
// selector, a "Can use cheats (game mode and commands)" toggle (off by default), Kick (online) and Ban / Unban (bans are
// saved in the world as meta.bans); the list refreshes every 2 s while open for the pings. The Pure Survival badge (Nov 11
// 2026): a mode select leaving Survival or granting the cheats permission asks first (the confirm box) and writes the badge
// off before it applies. A locked world disables every mode select ("This world is locked to <Mode>") and, locked to
// Survival, hides the cheats permission.
import { worldSetting, WORLD_TYPE_LABELS, lockedText } from '../core/WorldSettings.js';

const MODES = ['survival', 'creative', 'spectator'];
const cap = (m) => m.charAt(0).toUpperCase() + m.slice(1);

export class ServerSettingsMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('server-settings');
    this.defaultSel = document.getElementById('srv-default-mode');
    this.hostSel = document.getElementById('srv-host-mode');
    this.list = document.getElementById('srv-players');
    this.title = document.getElementById('srv-title');
    this.worldType = document.getElementById('srv-world-type');
    this.pvp = document.getElementById('srv-pvp');
    this.fallDamage = document.getElementById('srv-fall-damage');
    this.naturalMobs = document.getElementById('srv-natural-mobs');
    this.keepInv = document.getElementById('srv-keep-inv');
    this.hostile = document.getElementById('srv-hostile');
    this.explosives = document.getElementById('srv-explosives');
    this.explosionsBreak = document.getElementById('srv-explosions-break');
    this.lanOpen = document.getElementById('srv-lan-open');
    this.hostOnly = [...this.root.querySelectorAll('.srv-host-only')];
    this.onDone = null;
    this.timer = null;
    const toggle = (el, key, after = null) => el.addEventListener('change', () => { game.audio.playUI('click'); this._setWorld(key, el.checked); if (after) after(el.checked); });
    // World settings, saved in the world and sent to guests. Hostile mobs off despawns every zombie at once; natural spawning
    // off stops the first-generation groups, the respawn rounds and the zombie rounds; the explosives toggles stop placing /
    // block destruction (griefing protection); fall damage off makes landings harmless for players and mobs.
    toggle(this.pvp, 'pvp');
    toggle(this.keepInv, 'keepInventory');
    toggle(this.fallDamage, 'fallDamage', () => game.applyWorldSettings());
    toggle(this.naturalMobs, 'naturalMobs', (on) => { game.applyWorldSettings(); this.hostile.disabled = !on; });
    toggle(this.hostile, 'hostileMobs', () => game.applyWorldSettings());
    toggle(this.explosives, 'explosives');
    toggle(this.explosionsBreak, 'explosionsBreakBlocks');
    // Same Wi-Fi multiplayer is the switch: on opens the world to the network at once (unless a Multiplayer → Host server is
    // already running, which wins), off closes it (guests see "The host closed the server").
    toggle(this.lanOpen, 'lanOpen', (on) => {
      const net = game.net;
      if (on && !net) game.startHosting({ lan: true }).then(() => this.refresh());
      else if (!on && net && net.isHost && net.lanMode) game.stopHosting();
      this.refresh();
    });
    this.defaultSel.addEventListener('change', () => { game.audio.playUI('click'); this._setDefaultMode(this.defaultSel.value); }); // HostServer.defaultMode reads it
    this.hostSel.addEventListener('change', () => { game.audio.playUI('click'); Promise.resolve(game.requestGameMode(this.hostSel.value)).then(() => this.refresh()); }); // may ask about the badge; a locked world refuses
    document.getElementById('btn-srv-back').addEventListener('click', () => { game.audio.playUI('click'); this.close(); });
    game.events.on('net:changed', () => { if (this.visible) this.refresh(); });
    game.events.on('gamemode:changed', () => { if (this.visible) this.hostSel.value = game.player.gameMode; });
  }

  get visible() { return !this.root.classList.contains('hidden'); }

  open(onDone) { this.onDone = onDone; this.refresh(); this.root.classList.remove('hidden'); this._startTimer(); }
  /** Done: back to whoever opened the screen (the pause menu). */
  close() { this.root.classList.add('hidden'); this._stopTimer(); const cb = this.onDone; this.onDone = null; if (cb) cb(); }
  /** Hidden by a state change (the game resumed): no callback. */
  hide() { this.root.classList.add('hidden'); this._stopTimer(); this.onDone = null; }
  _startTimer() { this._stopTimer(); this.timer = setInterval(() => { if (this.visible && !this.root.contains(document.activeElement)) this.refresh(); }, 2000); }
  _stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** The game mode for other players: Survival at once; anything else first asks to give up the badge (and writes it off); never in a locked world. */
  _setDefaultMode(mode) {
    const g = this.game;
    if (!MODES.includes(mode) || g.lockedMode) { this.refresh(); return; }
    const apply = () => { this._setWorld('defaultGameMode', mode); this.refresh(); };
    if (mode !== 'survival' && g.badgeAtStake) g.loseBadge().then((ok) => { if (ok) apply(); else this.refresh(); });
    else apply();
  }

  /** Store a world setting (saved with the world) and tell connected guests. */
  _setWorld(key, value) {
    const g = this.game;
    if (!g.worldMeta) return;
    g.worldMeta[key] = value;
    g.session.changedSinceSave = true;
    if (g.net && g.net.isHost) g.net.broadcastWorldSettings();
  }

  refresh() {
    const g = this.game, net = g.net, meta = g.worldMeta;
    const hosting = !!(net && net.isHost);
    this.title.textContent = hosting ? 'Server Settings' : 'World Settings';
    for (const el of this.hostOnly) el.classList.toggle('hidden', !hosting);
    this.worldType.textContent = `World type: ${WORLD_TYPE_LABELS[worldSetting(meta, 'worldType')] || 'Default'}`;
    this.pvp.checked = worldSetting(meta, 'pvp') !== false;
    this.keepInv.checked = !!worldSetting(meta, 'keepInventory');
    this.fallDamage.checked = worldSetting(meta, 'fallDamage') !== false;
    const natural = worldSetting(meta, 'naturalMobs') !== false;
    this.naturalMobs.checked = natural;
    this.hostile.checked = worldSetting(meta, 'hostileMobs') !== false;
    this.hostile.disabled = !natural;
    this.explosives.checked = worldSetting(meta, 'explosives') !== false;
    this.explosionsBreak.checked = worldSetting(meta, 'explosionsBreakBlocks') !== false;
    this.lanOpen.checked = !!worldSetting(meta, 'lanOpen');
    const locked = g.lockedMode;
    const def = meta && MODES.includes(meta.defaultGameMode) ? meta.defaultGameMode : (meta && MODES.includes(meta.gameMode) ? meta.gameMode : 'survival');
    this.defaultSel.value = locked || (hosting ? net.defaultMode : def);
    this.hostSel.value = g.player.gameMode;
    // A locked world: no control changes a mode.
    for (const sel of [this.hostSel, this.defaultSel]) { sel.disabled = !!locked; sel.title = locked ? lockedText(locked) : ''; }
    this.list.textContent = '';
    if (!hosting) return;
    const rows = net.guestRows();
    if (!rows.length) { const e = document.createElement('div'); e.className = 'srv-empty'; e.textContent = 'No one has joined yet.'; this.list.appendChild(e); return; }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'srv-row' + (r.online ? ' online' : '') + (r.banned ? ' banned' : '');
      row.dataset.userId = r.userId;
      const name = document.createElement('span'); name.className = 'srv-name'; name.textContent = r.name + (r.banned ? ' (banned)' : r.online ? '' : ' (offline)'); row.appendChild(name);
      if (r.online) { const netEl = document.createElement("span"); netEl.className = "srv-net"; netEl.textContent = `${r.connection || "connecting"} · ${r.ping} ms`; row.appendChild(netEl); }
      if (r.banned) {
        const unban = document.createElement('button'); unban.className = 'mc-button tiny srv-unban'; unban.textContent = 'Unban';
        unban.addEventListener('click', () => { this.game.audio.playUI('click'); net.unban(r.userId); this.refresh(); });
        row.appendChild(unban);
        this.list.appendChild(row);
        continue;
      }
      const sel = document.createElement('select'); sel.className = 'srv-mode';
      for (const m of MODES) { const o = document.createElement('option'); o.value = m; o.textContent = cap(m); sel.appendChild(o); }
      sel.value = locked || r.mode;
      sel.disabled = !!locked; sel.title = locked ? lockedText(locked) : '';
      sel.addEventListener('change', () => {
        this.game.audio.playUI('click');
        const mode = sel.value;
        const apply = () => { net.setGuestMode(r.userId, mode); this.refresh(); };
        if (mode !== 'survival' && g.badgeAtStake) g.loseBadge().then((ok) => { if (ok) apply(); else this.refresh(); }); else apply(); // a guest leaving Survival takes the badge too
      });
      row.appendChild(sel);
      if (locked !== 'survival') { // locked to Survival: no cheats for anyone, so no permission to give
        const lab = document.createElement('label'); lab.className = 'srv-perm';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'srv-can-change'; cb.checked = !!r.canChangeMode;
        cb.addEventListener('change', () => {
          this.game.audio.playUI('click');
          const allow = cb.checked;
          const apply = () => { net.setGuestCanChange(r.userId, allow); this.refresh(); };
          if (allow && g.badgeAtStake) g.loseBadge().then((ok) => { if (ok) apply(); else { cb.checked = false; this.refresh(); } }); else apply(); // granting cheats takes the badge (asked first)
        });
        lab.appendChild(cb); lab.appendChild(document.createTextNode(' Can use cheats (game mode and commands)'));
        row.appendChild(lab);
      }
      if (r.online) {
        const kick = document.createElement('button'); kick.className = 'mc-button tiny srv-kick'; kick.textContent = 'Kick';
        kick.addEventListener('click', () => { this.game.audio.playUI('click'); net.kick(r.userId); this.refresh(); });
        row.appendChild(kick);
      }
      const ban = document.createElement('button'); ban.className = 'mc-button tiny danger srv-ban'; ban.textContent = 'Ban';
      ban.addEventListener('click', () => { this.game.audio.playUI('click'); net.ban(r.userId, r.name); this.refresh(); });
      row.appendChild(ban);
      this.list.appendChild(row);
    }
  }
}
