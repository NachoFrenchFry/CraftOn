// PauseMenu.js — Esc menu: resume, options, game mode toggle, save & quit (or Leave Server for guests), and while
// hosting a LAN server the "Hosting: <world> · Code ABC123 · N/8 players" line with Server Settings (Update #9)
// and Stop Hosting (Update #8). A guest without permission sees its game mode button disabled.

export class PauseMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('pause-menu');
    this.modeButton = document.getElementById('btn-gamemode');
    this.quitButton = document.getElementById('btn-save-quit');
    this.hostingLine = document.getElementById('pause-hosting');
    this.stopHostingButton = document.getElementById('btn-stop-hosting');
    this.serverSettingsButton = document.getElementById('btn-server-settings');
    this.buttons = ['btn-resume', 'btn-pause-options', 'btn-gamemode', 'btn-save-quit', 'btn-stop-hosting', 'btn-server-settings'].map((id) => document.getElementById(id));
    this.serverSettingsButton.addEventListener('click', () => { game.audio.playUI('click'); this.hide(); game.ui.serverSettings.open(() => this.show()); });
    this.stopHostingButton.addEventListener('click', () => { game.audio.playUI('click'); game.stopHosting(); this.refresh(); });
    game.events.on('net:changed', () => { if (!this.root.classList.contains('hidden')) this.refresh(); });
    document.getElementById('btn-resume').addEventListener('click', () => { game.audio.playUI('click'); game.resume(); });
    document.getElementById('btn-pause-options').addEventListener('click', () => {
      game.audio.playUI('click');
      this.hide();
      game.ui.options.open(() => this.show());
    });
    this.modeButton.addEventListener('click', () => { game.audio.playUI('click'); game.cycleGameMode(); this.refresh(); });
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
    this.modeButton.textContent = `Game Mode: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
    const net = g.net;
    const hosting = !!(net && net.isHost);
    this.hostingLine.classList.toggle('hidden', !hosting);
    if (hosting) this.hostingLine.textContent = `Hosting: ${net.worldName} · Code ${net.joinCode} · ${net.playerCount}/${net.maxPlayers} players` + (net.networkDetected ? '' : " · Couldn't detect your network (Join by code only)") + ' · keep this tab visible';
    this.stopHostingButton.classList.toggle('hidden', !hosting);
    this.serverSettingsButton.classList.toggle('hidden', g.isGuest); // host: Server Settings; single player: World Settings
    this.serverSettingsButton.textContent = hosting ? 'Server Settings…' : 'World Settings…';
    this.modeButton.disabled = !!(g.isGuest && !g.net.canChangeMode);
    this.modeButton.title = this.modeButton.disabled ? 'The host controls your game mode.' : '';
    this.quitButton.textContent = g.isGuest ? 'Leave Server' : 'Save & Quit to Title';
  }

  show() { this.refresh(); this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); if (this.game.ui && this.game.ui.serverSettings) this.game.ui.serverSettings.hide(); }
}
