// PerformanceMonitor.js — frame-rate watcher (Update #9 §7 / §4): the Auto render scale (steps down while the FPS
// stays under the target, back up when there is headroom), the one-time "Performance mode" suggestion on a weak
// device (few CPU cores, or under 30 fps in the first 15 s of play) and the one-time shader tip (under about
// 30 fps for 10 s after enabling shaders). Suppressed under ?debuglog unless ?perfsuggest is set, so the headless
// tests stay deterministic.
import { State } from './GameState.js';

const SUGGESTED_KEY = 'crafton.perfSuggested.v1';

export class PerformanceMonitor {
  /** @param {import('./Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.lowTime = 0; this.highTime = 0;
    this.playTime = 0; this.samples = [];
    this.suggested = this._flag();
    this.shaderLowTime = 0; this.shaderTipShown = false; this.shaderTipArmed = false;
    this.root = document.getElementById('perf-suggest');
    this.text = document.getElementById('perf-suggest-text');
    document.getElementById('btn-perf-apply').addEventListener('click', () => { game.audio.playUI('click'); game.ui.options.applyPerformanceMode(); this.hideSuggestion(); });
    document.getElementById('btn-perf-dismiss').addEventListener('click', () => { game.audio.playUI('click'); this.hideSuggestion(); });
    game.events.on('settings:changed', (key, value) => { if (key === 'shadersOn') { this.shaderTipArmed = !!value; this.shaderLowTime = 0; } });
  }

  _flag() { try { return !!localStorage.getItem(SUGGESTED_KEY); } catch (e) { return true; } }
  _markSuggested() { this.suggested = true; try { localStorage.setItem(SUGGESTED_KEY, '1'); } catch (e) { /* ignore */ } }

  /** FPS the game is trying to reach: the cap when set (at most 60), else 60. */
  get targetFps() { const cap = this.game.loop.maxFps; return cap > 0 ? Math.min(60, cap) : 60; }

  get suggestionsAllowed() { return !this.game.debuglog || this.game.perfSuggestForced; }

  update(dt) {
    const g = this.game;
    if (!g.state.inWorld) return;
    const fps = g.loop.fps;
    const target = this.targetFps;
    // Auto render scale: 1 → 0.75 → 0.5 while under 85 % of the target for 3 s; back up after 10 s at the target.
    if (g.settings.get('renderScale') === 0) {
      if (fps > 0 && fps < target * 0.85) { this.lowTime += dt; this.highTime = 0; }
      else if (fps >= target * 0.97) { this.highTime += dt; this.lowTime = 0; }
      let s = g.renderer.autoScale;
      if (this.lowTime > 3 && s > 0.5) { s -= 0.25; this.lowTime = 0; g.renderer.setAutoScale(s); }
      else if (this.highTime > 10 && s < 1) { s += 0.25; this.highTime = 0; g.renderer.setAutoScale(s); }
    } else { this.lowTime = 0; this.highTime = 0; }
    // One-time Performance mode suggestion.
    if (!this.suggested && g.state.is(State.PLAYING) && this.suggestionsAllowed) {
      this.playTime += dt;
      if (fps > 0) this.samples.push(fps);
      const cores = navigator.hardwareConcurrency || 8;
      if (this.playTime > 3 && cores <= 4) this.suggest(`This device has ${cores} CPU cores. Performance mode lowers the render scale and distances for a smoother game.`);
      else if (this.playTime > 15) {
        const avg = this.samples.length ? Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length) : 60;
        if (avg < 30) this.suggest(`The game ran at about ${avg} fps. Performance mode lowers the render scale and distances for a smoother game.`);
        else this._markSuggested();
      }
    }
    // One-time shader tip (§4): under about 30 fps for 10 s after enabling shaders.
    if (this.shaderTipArmed && !this.shaderTipShown && g.settings.get('shadersOn') && this.suggestionsAllowed) {
      if (fps > 0 && fps < 30) this.shaderLowTime += dt; else this.shaderLowTime = 0;
      if (this.shaderLowTime > 10) { this.shaderTipShown = true; g.ui.hud.showToast('Shaders are slow here: try a lower preset in Options → Shaders…', false); }
    }
  }

  suggest(text) {
    this._markSuggested();
    this.text.textContent = text;
    this.root.classList.remove('hidden');
    this.game.input.exitPointerLock();
    this.game.pause();
  }

  hideSuggestion() { this.root.classList.add('hidden'); }
  get suggestionVisible() { return !this.root.classList.contains('hidden'); }
}
