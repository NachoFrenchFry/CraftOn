// Settings.js — user options persisted in localStorage with change events.

import { DEFAULT_SETTINGS, normalizeSetting } from '../config/DefaultSettings.js';

const STORAGE_KEY = 'crafton.settings.v1';
/** The keys the player set themselves (the options screen, a preset, the URL): a changed default never overrides those. */
const CHANGED_KEY = 'crafton.settings.changed.v1';

export class Settings {
  /** Values from the URL applied on load without being saved ({ key: string }); main.js fills it before the Game exists. */
  static urlOverrides = null;
  /** @param {import('./EventBus.js').EventBus} events */
  constructor(events) {
    this.events = events;
    this.values = { ...DEFAULT_SETTINGS };
    /** Keys the player changed (persisted): a default that changes later leaves those values alone. */
    this.changed = new Set();
    /** True while a benchmark runs: changes stay in memory and are never persisted. */
    this.transient = false;
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (key in parsed && typeof parsed[key] === typeof DEFAULT_SETTINGS[key]) this.values[key] = normalizeSetting(key, parsed[key]);
        }
      }
      const changed = localStorage.getItem(CHANGED_KEY);
      if (changed) for (const key of JSON.parse(changed)) if (key in DEFAULT_SETTINGS) this.changed.add(key);
      // Keys of removed settings (farDistance, farQuality…) in a saved file are simply left out: only known keys are read.
      // URL overrides (tests, the benchmark): in memory only, never saved, for values the Game constructor already needs.
      for (const [key, value] of Object.entries(Settings.urlOverrides || {})) if (key in DEFAULT_SETTINGS) this.values[key] = normalizeSetting(key, typeof DEFAULT_SETTINGS[key] === 'number' ? Number(value) : typeof DEFAULT_SETTINGS[key] === 'boolean' ? value === 'true' || value === '1' : String(value));
    } catch (e) {
      console.warn('Settings: could not load, using defaults', e);
    }
  }

  save() {
    if (this.transient) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
      localStorage.setItem(CHANGED_KEY, JSON.stringify([...this.changed]));
    } catch (e) {
      console.warn('Settings: could not save', e);
    }
  }

  get(key) { return this.values[key]; }

  /** Set a value, persist it and notify listeners ('settings:changed', key, value). */
  set(key, value) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting ${key}`);
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.changed.add(key);
    this.save();
    this.events.emit('settings:changed', key, value);
  }

  reset() {
    for (const key of Object.keys(DEFAULT_SETTINGS)) this.set(key, DEFAULT_SETTINGS[key]);
  }

  /** Apply several values at once (a preset button). */
  applyPreset(values) {
    for (const [key, value] of Object.entries(values)) this.set(key, value);
  }
}
