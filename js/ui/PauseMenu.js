// PauseMenu.js — Esc menu: resume, Settings, game mode toggle, save & quit (or Leave Server for guests), and while
// hosting the "Hosting: <world> · Public · Code ABC123 · N/8 players" line with Server Settings and Stop Hosting — or, for
// a world open through its Same Wi-Fi multiplayer setting, "Open to your Wi-Fi · Code ABC123 · N/8 players" without Stop
// Hosting (the setting is the switch). A guest without permission sees its game mode button disabled. Under the title the
// world's tags (Nov 11 2026): the green Pure Survival badge while the world has it, a gray Locked tag for a locked world —
// whose Game Mode button is disabled with "This world is locked to <Mode>"; leaving Survival with the button asks first.
import { lockedText, modeName } from '../core/WorldSettings.js';

export class PauseMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('pause-menu');
    this.modeButton = document.getElementById('btn-gamemode');
    this.quitButton = document.getElementById('btn-save-quit');
    this.hostingLine = document.getElementById('pause-hosting');
    this.tags = document.getElementById('pause-tags');
    this.stopHostingButton = document.getElementById('btn-stop-hosting');
    this.serverSettingsButton = document.getElementById('btn-server-settings');
    this.buttons = ['btn-resume', 'btn-pause-options', 'btn-gamemode', 'btn-save-quit', 'btn-stop-hosting', 'btn-server-settings'].map((id) => document.getElementById(id));
    this.serverSettingsButton.addEventListener('click', () => { game.audio.playUI('click'); this.hide(); game.ui.serverSettings.open(() => this.show()); });
    this.stopHostingButton.addEventListener('click', () => { game.audio.playUI('click'); game.stopHosting(true); this.refresh(); }); // a world with Same Wi-Fi multiplayer on reopens to the network
    game.events.on('net:changed', () => { if (!this.root.classList.contains('hidden')) this.refresh(); });
    game.events.on('badge:changed', () => { if (!this.root.classList.contains('hidden')) this.refresh(); });
    game.events.on('gamemode:changed', () => { if (!this.root.classList.contains('hidden')) this.refresh(); });
    document.getElementById('btn-resume').addEventListener('click', () => { game.audio.playUI('click'); game.resume(); });
    document.getElementById('btn-pause-options').addEventListener('click', () => {
      game.audio.playUI('click');
      this.hide();
      game.ui.settings.open(() => this.show());
    });
    this.modeButton.addEventListener('click', () => { game.audio.playUI('click'); Promise.resolve(game.cycleGameMode()).then(() => this.refresh()); }); // may ask about the badge first
    document.getElementById('btn-save-quit').addEventListener('click', () => { game.audio.playUI('click'); game.saveAndQuit(); });
  }

  /** Save & Quit in progress: every button disabled, the quit button shows a spinner (no double clicks). */
  setBusy(busy) {
    for (const b of this.buttons) b.disabled = busy;
    this.quitButton.classList.toggle('busy', busy);
    if (busy) this.quitButton.innerHTML = `<span class="spinner"></span>${this.game.isGuest ? 'Leaving…' : 'Saving…'}`;
    else this.quitButton.textContent = this.game.isGuest ? 'Leave Server' : 'Save & Quit to Title';
  }

  refresh() {
    const g = this.game;
    const mode = g.player.gameMode;
    this.modeButton.textContent = `Game Mode: ${modeName(mode)}`;
    // The world's tags: the badge and the lock (guests get both through WELCOME / WORLD).
    this.tags.textContent = '';
    if (g.survivalOnly) { const t = document.createElement('span'); t.className = 'tag tag-green'; t.id = 'pause-tag-survival'; t.textContent = 'Pure Survival'; t.title = 'This world has only ever been played in Survival, without cheats'; this.tags.appendChild(t); }
    const locked = g.lockedMode;
    if (locked) { const t = document.createElement('span'); t.className = 'tag tag-gray'; t.id = 'pause-tag-locked'; t.textContent = 'Locked'; t.title = lockedText(locked); this.tags.appendChild(t); }
    const net = g.net;
    const hosting = !!(net && net.isHost);
    this.hostingLine.classList.toggle('hidden', !hosting);
    if (hosting && net.lanMode) this.hostingLine.textContent = `Open to your Wi-Fi · Code ${net.joinCode} · ${net.playerCount}/${net.maxPlayers} players` + (net.networkDetected ? '' : ` · Couldn't detect your Wi-Fi. Players can still join with code ${net.joinCode}.`);
    else if (hosting) this.hostingLine.textContent = `Hosting: ${net.worldName} · ${net.visibility === 'private' ? 'Private' : 'Public'} · Code ${net.joinCode} · ${net.playerCount}/${net.maxPlayers} players` + (net.networkDetected ? '' : " · Couldn't detect your network (Join by code only)") + ' · keep this tab visible';
    this.stopHostingButton.classList.toggle('hidden', !hosting || !!net.lanMode);
    this.serverSettingsButton.classList.toggle('hidden', g.isGuest); // host: Server Settings; single player: World Settings
    this.serverSettingsButton.textContent = hosting ? 'Server Settings…' : 'World Settings…';
    this.modeButton.disabled = !!locked || !!(g.isGuest && !g.net.canChangeMode);
    this.modeButton.title = locked ? lockedText(locked) : this.modeButton.disabled ? 'The host controls your game mode.' : '';
    this.quitButton.textContent = g.isGuest ? 'Leave Server' : 'Save & Quit to Title';
  }

  show() { this.refresh(); this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); if (this.game.ui && this.game.ui.serverSettings) this.game.ui.serverSettings.hide(); }
}
