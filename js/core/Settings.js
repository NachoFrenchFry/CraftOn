// Settings.js — user options persisted in localStorage with change events.

import { DEFAULT_SETTINGS, normalizeSetting } from '../config/DefaultSettings.js';

const STORAGE_KEY = 'crafton.settings.v1';

export class Settings {
  /** @param {import('./EventBus.js').EventBus} events */
  constructor(events) {
    this.events = events;
    this.values = { ...DEFAULT_SETTINGS };
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
    } catch (e) {
      console.warn('Settings: could not load, using defaults', e);
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
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
