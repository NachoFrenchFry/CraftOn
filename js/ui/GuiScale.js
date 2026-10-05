// GuiScale.js — computes the GUI scale from the window size (or the user override) and publishes it
// as the --gui-scale CSS variable so every UI element scales crisply.

const MAX_AUTO_SCALE = 4;

export class GuiScale {
  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../core/EventBus.js').EventBus} events
   */
  constructor(settings, events) {
    this.settings = settings;
    this.events = events;
    this.scale = 2;
    events.on('renderer:resize', () => this.update());
    events.on('settings:changed', (key) => { if (key === 'guiScale') this.update(); });
    this.update();
  }

  static autoScale(w, h) {
    return Math.max(1, Math.min(MAX_AUTO_SCALE, Math.floor(w / 320), Math.floor(h / 240)));
  }

  update() {
    const override = this.settings.get('guiScale');
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    const auto = GuiScale.autoScale(w, h);
    const scale = override > 0 ? Math.min(override, Math.max(1, auto + 1)) : auto;
    if (scale === this.scale) return;
    this.scale = scale;
    document.documentElement.style.setProperty('--gui-scale', String(scale));
    this.events.emit('gui:scale', scale);
  }
}
