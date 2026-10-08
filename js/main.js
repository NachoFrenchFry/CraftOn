// main.js — entry point: environment checks, create the Game, boot, optional URL flags for testing.
//   ?atlas          open the texture atlas debug view after boot
//   ?autoplay       create a world immediately (optional &seed=... &mode=creative &name=...)
//   ?world=<id>     continue a saved world immediately
//   ?debuglog       print state / chunk statistics to the console every 2 s and the startup timings (headless testing)
//   ?shot=5,10      with debuglog: POST canvas screenshots to /__shot after those many seconds
//   ?look=yaw,pitch with debuglog: initial look angles in degrees
//   ?mockcloud      use the in-memory MockSupabase instead of the real project (all headless tests)
//   ?guestlogin=<n> with mockcloud: ignore the restored session and log in as test account <n> (two-tab tests)
//
// Startup (Update #7): the static boot screen in index.html is visible before this module runs; boot() loads
// textures, sheets, the cloud client + session and the sounds in parallel while the step text updates, then
// the account screen or the main menu replaces it.

import { Game } from './core/Game.js';
import { State } from './core/GameState.js';
import { hashSeed, randomSeed } from './utils/Random.js';

/** Worlds used to live in IndexedDB (database "crafton"); since Update #6 they live in the cloud. Delete the old store once. */
function deleteOldLocalWorlds() {
  const FLAG = 'crafton.localWorldsDeleted.v1';
  try {
    if (localStorage.getItem(FLAG) || typeof indexedDB === 'undefined') return;
    const req = indexedDB.deleteDatabase('crafton');
    req.onsuccess = req.onerror = req.onblocked = () => { try { localStorage.setItem(FLAG, '1'); } catch (e) { /* ignore */ } };
  } catch (e) { /* storage unavailable */ }
}

function fatal(html) {
  const el = document.getElementById('fatal-message');
  el.classList.remove('hidden');
  el.querySelector('.fatal-content').innerHTML = html;
}

function hasWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch (e) { return false; }
}

/** Fetch duration (ms) of the first loaded resource whose URL contains `part`, or null. */
function resourceMs(part) {
  const e = performance.getEntriesByType('resource').find((r) => r.name.includes(part));
  return e ? e.duration : null;
}

async function main() {
  if (location.protocol === 'file:') return; // inline script already explained the local-server requirement
  if (!hasWebGL2()) {
    document.getElementById('boot-screen').classList.add('hidden');
    fatal('<h2>WebGL2 is required</h2><p>Your browser or GPU does not support WebGL2. Try a recent Chrome, Edge, Firefox or Safari.</p>');
    return;
  }
  const canvas = document.getElementById('game-canvas');
  const game = new Game(canvas);
  window.crafton = game; // handy for debugging in the console
  const params = new URLSearchParams(location.search);
  game.cloudMock = params.has('mockcloud');
  game.debuglog = params.has('debuglog');
  const T = game.timing;
  // Page load = navigation start → this module running (HTML, CSS, import map and the whole module graph).
  T.add('page load (navigation → main.js)', performance.now(), `${performance.getEntriesByType('resource').filter((r) => /\/js\/.*\.js/.test(r.name)).length} game modules`);
  const three = resourceMs('three.module');
  if (three !== null) T.add('three.js import (fetch)', three);
  deleteOldLocalWorlds();
  const boot = game.bootScreen;
  try {
    await game.boot((text, fraction) => boot.setStep(text, fraction));
  } catch (e) {
    console.error(e);
    boot.hide();
    fatal(`<h2>CraftOn failed to start</h2><pre>${String(e && e.stack || e)}</pre>`);
    return;
  }
  if (!game.cloudMock) { const sb = resourceMs('supabase-js'); if (sb !== null) T.add('supabase-js import (fetch)', sb); }
  // Accounts (Update #6): a persisted session skips the account screen; tests with the mock log in a
  // throwaway account automatically so ?autoplay / ?world keep working.
  boot.setStep('Signing in…', 0.75);
  let loggedIn = await game.sessionTask;
  if (game.cloudMock && params.has('guestlogin')) {
    // Two-tab tests: this tab plays as its own throwaway account instead of the one shared in localStorage.
    const name = params.get('guestlogin');
    if (loggedIn) await game.account.signOut();
    const r = await game.account.signUp(name, 'guestpass1', 'guestpass1');
    loggedIn = r.ok || (await game.account.signIn(name, 'guestpass1')).ok;
    if (loggedIn) game.prefetchWorlds();
  }
  if (!loggedIn && game.cloudMock && (params.has('autoplay') || params.has('world'))) {
    const r = await game.account.signUp('tester', 'testpass123', 'testpass123');
    loggedIn = r.ok || (await game.account.signIn('tester', 'testpass123')).ok;
    if (loggedIn) game.prefetchWorlds();
  }
  if (loggedIn) {
    boot.setStep('Loading your worlds…', 0.9);
    await Promise.all([game.awaitWorldList(1500), game.sessionGuard.claim()]); // one place per account: claim it now
  }
  boot.setStep('Ready', 1);
  game.state.set(loggedIn ? State.MENU : State.ACCOUNT);
  T.add('total: navigation → first screen', performance.now());
  if (params.has('atlas')) game.ui.toggleAtlasView();
  if (params.has('debuglog')) {
    game.ignoreHidden = true;
    game.perfSuggestForced = params.has('perfsuggest'); // the one-time Performance mode popup is otherwise suppressed in tests
    if (params.has('rd')) game.settings.set('renderDistance', Number(params.get('rd')));
    game.loop.timerMode = true;
    game.loop.timerInterval = Number(params.get('tick') || 60);
    game.loop.stop(); game.loop.start();
    window.addEventListener('error', (e) => console.error('CRAFTON_ERROR', e.message, e.filename, e.lineno));
    window.addEventListener('unhandledrejection', (e) => console.error('CRAFTON_REJECTION', e.reason && (e.reason.stack || e.reason)));
    game.events.on('state:changed', (s, prev) => console.log(`CRAFTON state ${prev} -> ${s}`));
    T.report('boot');
    game.audio.bank.rendering?.then(() => T.report('boot'));
    const shots = (params.get('shot') || '').split(',').filter(Boolean).map(Number);
    const look = (params.get('look') || '').split(',').map(Number);
    const t0 = performance.now();
    let shotIndex = 0;
    game.afterRender = () => {
      if (look.length === 2 && !Number.isNaN(look[0])) { game.player.yaw = look[0] * Math.PI / 180; game.player.pitch = look[1] * Math.PI / 180; }
      const elapsed = (performance.now() - t0) / 1000;
      if (shotIndex < shots.length && elapsed >= shots[shotIndex]) {
        const name = `shot_${shots[shotIndex]}`;
        shotIndex++;
        const data = game.canvas.toDataURL('image/png');
        fetch(`/__shot?name=${name}`, { method: 'POST', body: data }).then(() => console.log('CRAFTON shot saved', name));
      }
    };
    setInterval(() => {
      const p = game.player.position;
      const st = game.chunkManager.stats();
      const info = game.renderer.worldStats; const gt = game.chunkManager.genTiming;
      console.log(`CRAFTON stats state=${game.state.current} fps=${game.loop.fps} pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} chunks=${st.loaded} meshes=${st.meshes} meshPending=${st.meshPending} genQueue=${st.genQueue} calls=${info.calls} tris=${info.triangles} items=${game.entities.items.length} audio=${game.audio.ready} sounds=${game.audio.bank.rendered}/${game.audio.bank.total} genAvgMs=${gt.count ? (gt.total / gt.count).toFixed(1) : '-'} meshAvgMs=${game.chunkManager.meshTiming.count ? (game.chunkManager.meshTiming.total / game.chunkManager.meshTiming.count).toFixed(1) : '-'}`);
    }, 2000);
  }
  if (!loggedIn) return; // the account screen takes over; nothing below can run without a session
  if (params.has('world')) game.startWorld(params.get('world'));
  else if (params.has('autoplay')) {
    const seedText = params.get('seed') || '';
    const record = await game.saveManager.createWorld({
      name: params.get('name') || 'Test World',
      seed: seedText ? hashSeed(seedText) : randomSeed(),
      seedText,
      gameMode: params.get('mode') === 'creative' ? 'creative' : 'survival',
    });
    game.startWorld(record.id);
  }
}

main();
