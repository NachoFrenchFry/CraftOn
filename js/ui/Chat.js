// Chat.js — the top-left chat (Update #12), after bloxd.io: every message is its own small rounded translucent
// slate-blue box, only as wide as its text (up to 40 % of the screen), "Name: message" with a gold [Host] tag for
// the host, system lines (joins, leaves, deaths, command feedback) in yellow / gray / red without a name. T, Enter
// or "/" open it: the input bar appears under the messages, the whole history shows with a scrollbar, the mouse is
// free and game keys are ignored while the game keeps running. Enter sends (a line starting with "/" runs a
// command), Esc closes, ↑ / ↓ recall sent messages, Tab completes commands. Closed, the last 10 messages show and
// each fades out about 10 s after it arrived. The last 100 messages are kept per session (never saved). Every piece
// of text goes through textContent — names and messages can never run HTML.
const MAX_HISTORY = 100;
const MAX_SHOWN_CLOSED = 10;
const FADE_AFTER = 10;    // seconds a message stays fully visible while the chat is closed
const FADE_SECONDS = 1;   // then fades out over this long
const MAX_SENT = 50;
export const CHAT_MAX_LENGTH = 256;

/** Strip control characters and trim; '' when nothing printable is left. */
export function cleanChatText(text) {
  return String(text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CHAT_MAX_LENGTH);
}

export class Chat {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('chat');
    this.list = document.getElementById('chat-messages');
    this.input = document.getElementById('chat-input');
    this.isOpen = false;
    /** { el, time } per shown message, oldest first (time = seconds since this chat was created). */
    this.lines = [];
    this.sent = [];
    this.sentIndex = -1;
    this.draft = '';
    this.time = 0;
    this.input.addEventListener('keydown', (e) => this._onInputKey(e));
    this.input.addEventListener('blur', () => { if (this.isOpen) this.input.focus(); }); // the mouse may be used to scroll / select text; typing continues
    this.input.addEventListener('input', () => { this.sentIndex = -1; });
  }

  /** Forget everything (a new world / server). */
  clear() {
    this.lines.length = 0;
    this.list.textContent = '';
    this.sent.length = 0;
    this.sentIndex = -1;
    if (this.isOpen) this.close(false);
  }

  // ---- messages ----

  /** A player's message: { name, text, host } (text already validated by the sender / the host). */
  add({ name, text, host = false }) {
    const line = document.createElement('div');
    line.className = 'chat-line';
    if (host) { const tag = document.createElement('span'); tag.className = 'chat-host'; tag.textContent = '[Host] '; line.appendChild(tag); }
    const who = document.createElement('span'); who.className = 'chat-name'; who.textContent = `${name}: `;
    const body = document.createElement('span'); body.className = 'chat-text'; body.textContent = text;
    line.append(who, body);
    this._push(line);
  }

  /** A system line without a name: `kind` 'yellow' (joins, leaves, deaths), 'gray' (command feedback) or 'red' (errors). */
  system(text, kind = 'yellow') {
    const line = document.createElement('div');
    line.className = `chat-line chat-system chat-${kind}`;
    line.textContent = text;
    this._push(line);
  }

  _push(line) {
    this.list.appendChild(line);
    this.lines.push({ el: line, time: this.time, hidden: null, opacity: -2 });
    while (this.lines.length > MAX_HISTORY) { const old = this.lines.shift(); old.el.remove(); }
    this._refreshVisibility();
    if (this.isOpen) this.list.scrollTop = this.list.scrollHeight;
  }

  /** Closed: only the last MAX_SHOWN_CLOSED, fading after FADE_AFTER seconds; open: everything, opaque. */
  _refreshVisibility() {
    const n = this.lines.length;
    // Only lines whose state changes touch the DOM (Update #14 §3): opacity in 1/50 steps, hidden flag cached per line.
    for (let i = 0; i < n; i++) {
      const line = this.lines[i];
      const { el, time } = line;
      if (this.isOpen) { if (line.hidden !== false || line.opacity !== -1) { line.hidden = false; line.opacity = -1; el.classList.remove('hidden'); el.style.opacity = ''; } continue; }
      const age = this.time - time;
      const hidden = i < n - MAX_SHOWN_CLOSED || age >= FADE_AFTER + FADE_SECONDS;
      if (hidden !== line.hidden) { line.hidden = hidden; el.classList.toggle('hidden', hidden); }
      if (hidden) continue;
      const op = age > FADE_AFTER ? Math.round(Math.max(0, 1 - (age - FADE_AFTER) / FADE_SECONDS) * 50) / 50 : -1;
      if (op !== line.opacity) { line.opacity = op; el.style.opacity = op < 0 ? '' : String(op); }
    }
  }

  /** Real-time per frame (fades are UI, never scaled by /tick). */
  update(realDt) {
    this.time += realDt;
    if (this.isOpen || !this.lines.length) return;
    // Nothing to do once every line has faded out, until the next message arrives.
    const last = this.lines[this.lines.length - 1];
    if (last.hidden === true && this.time - last.time >= FADE_AFTER + FADE_SECONDS) return;
    this._refreshVisibility();
  }

  // ---- opening and closing ----

  /** Open with the box empty, or with `prefill` (the "/" key opens with a slash already typed). */
  open(prefill = '') {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.classList.add('open');
    this.input.classList.remove('hidden');
    this.input.value = prefill;
    this.sentIndex = -1;
    this.draft = '';
    this._refreshVisibility();
    this.list.scrollTop = this.list.scrollHeight;
    const g = this.game;
    g.input.textInputActive = true;
    g.lock.release('chat'); // the game's own unlock: no cooldown, no pause menu
    if (g.ui.hud) g.ui.hud.setPointerHint(false);
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    g.events.emit('chat:opened');
  }

  /**
   * Close the box. `viaKey` is true when a key press closed it (Enter): that press counts as user activation, so
   * the mouse re-locks at once; after Esc the lock comes back on the next key press or click.
   */
  close(viaKey = false) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('open');
    this.input.classList.add('hidden');
    this.input.blur();
    this.game.input.textInputActive = false;
    this._refreshVisibility();
    this.game.onChatClosed(viaKey);
  }

  _onInputKey(e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); this._send(); this.close(true); return; }
    if (e.key === 'Escape') { e.preventDefault(); this.close(false); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const r = this.game.commands.complete(this.input.value);
      if (r.text !== this.input.value) { this.input.value = r.text; this.input.setSelectionRange(r.text.length, r.text.length); }
      else if (r.candidates.length > 1) this.system(r.candidates.join('  '), 'gray');
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.sent.length) return;
      if (this.sentIndex === -1) this.draft = this.input.value;
      let i = this.sentIndex === -1 ? this.sent.length : this.sentIndex;
      i += e.key === 'ArrowUp' ? -1 : 1;
      if (i < 0) i = 0;
      if (i >= this.sent.length) { this.sentIndex = -1; this.input.value = this.draft; return; }
      this.sentIndex = i;
      this.input.value = this.sent[i];
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }
  }

  _send() {
    const text = cleanChatText(this.input.value);
    this.input.value = '';
    if (!text) return;
    if (this.sent[this.sent.length - 1] !== text) { this.sent.push(text); if (this.sent.length > MAX_SENT) this.sent.shift(); }
    this.sentIndex = -1;
    if (text.startsWith('/')) this.game.commands.run(text, (line, kind) => this.system(line, kind === 'error' ? 'red' : 'gray'));
    else this.game.sendChat(text);
  }
}
