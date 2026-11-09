// SettingsMenu.js — the one Settings screen (#settings-menu, opened by the main menu's and the pause menu's Settings
// buttons): a column of tabs on the left — Video, Performance, Shaders, Audio, Controls from SETTING_TABS, each with its
// 16×16 icon, Done at the bottom — and the selected tab's panel on the right: the tab's name as a heading, a gray
// description line and a scrolling list of one-row settings. The rows come from OptionsTab (the schema rows and the
// Performance mode button), ShadersTab and ControlsTab, all built on SettingRow. The selected tab is remembered while
// the page stays open and starts on Video; while the panel is under 300 gui-pixels wide the tabs show only their icons.

import { SETTING_TABS } from '../config/DefaultSettings.js';
import { OptionsTab } from './OptionsTab.js';
import { ShadersTab } from './ShadersTab.js';
import { ControlsTab } from './ControlsTab.js';

/** Panels narrower than this many gui-pixels show icon-only tabs (the name stays in each button's title). */
export const ICONS_ONLY_BELOW = 300;

export class SettingsMenu {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('settings-menu');
    this.content = this.root.querySelector('.settings-content');
    this.tabColumn = document.getElementById('settings-tabs');
    this.panelHost = document.getElementById('settings-panels');
    this.doneButton = document.getElementById('btn-settings-done');
    this.onDone = null;
    /** The selected tab id; remembered while the page is open. */
    this.tab = SETTING_TABS[0].id;
    /** tab id → its button / its panel */
    this.tabButtons = new Map();
    this.panels = new Map();
    this.options = new OptionsTab(game, () => this.isOpen);
    for (const tab of SETTING_TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mc-button settings-tab';
      button.dataset.tab = tab.id;
      button.title = tab.name;
      const icon = document.createElement('img');
      icon.className = 'settings-tab-icon'; icon.src = tab.icon; icon.alt = ''; icon.draggable = false;
      const name = document.createElement('span');
      name.className = 'settings-tab-name'; name.textContent = tab.name;
      button.append(icon, name);
      button.addEventListener('click', () => { game.audio.playUI('click'); this.selectTab(tab.id); });
      this.tabColumn.insertBefore(button, this.doneButton);
      this.tabButtons.set(tab.id, button);
      const panel = document.createElement('div');
      panel.className = 'settings-panel hidden';
      panel.id = `settings-panel-${tab.id}`;
      panel.dataset.tab = tab.id;
      const head = document.createElement('div');
      head.className = 'settings-head';
      const heading = document.createElement('h2');
      heading.className = 'menu-heading'; heading.textContent = tab.name;
      const desc = document.createElement('div');
      desc.className = 'settings-desc'; desc.textContent = tab.description;
      head.append(heading, desc);
      const list = document.createElement('div');
      list.className = 'settings-list';
      panel.append(head, list);
      this.panelHost.appendChild(panel);
      this.panels.set(tab.id, panel);
      if (tab.id === 'shaders') this.shaders = new ShadersTab(game, list, () => this.tabVisible('shaders'), () => this.isOpen);
      else {
        this.options.build(tab.id, list);
        if (tab.id === 'controls') this.controls = new ControlsTab(game, list, () => this.isOpen);
      }
    }
    this.doneButton.addEventListener('click', () => { game.audio.playUI('click'); this.close(); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this._fit()).observe(this.content);
    this.selectTab(this.tab);
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }

  /** Whether a tab's panel is on screen right now. */
  tabVisible(id) { return this.isOpen && this.tab === id; }

  /** Show one tab's panel and mark its button; leaving the Controls tab cancels a pending key capture. */
  selectTab(id) {
    if (!this.panels.has(id)) return;
    if (id !== 'controls') this.controls.stopListening();
    this.tab = id;
    for (const [tabId, button] of this.tabButtons) button.classList.toggle('active', tabId === id);
    for (const [tabId, panel] of this.panels) panel.classList.toggle('hidden', tabId !== id);
    if (id === 'shaders') this.shaders.refresh(); // the FPS line reads the current rate at once
  }

  /** Icon-only tabs while the panel is narrow (under ICONS_ONLY_BELOW gui-pixels); checked on open and on every resize. */
  _fit() {
    const width = this.content.clientWidth;
    if (!width) return; // hidden: keep the last decision
    this.content.classList.toggle('icons-only', width < ICONS_ONLY_BELOW * this.game.guiScale.scale);
  }

  /** The Performance mode preset (the Performance tab's button and the slow-device popup). */
  applyPerformanceMode() { this.options.applyPerformanceMode(); }

  refresh() { this.options.refresh(); this.shaders.refresh(); this.controls.refresh(); }

  /** Called every frame from UIManager: the Shaders tab's FPS readout, only while that tab is on screen. */
  update(dt) { if (this.tabVisible('shaders')) this.shaders.update(dt); }

  open(onDone) {
    this.onDone = onDone;
    this.refresh();
    this.root.classList.remove('hidden');
    this._fit();
  }

  close() {
    this.controls.stopListening();
    this.root.classList.add('hidden');
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb();
  }
}
