// Chat.js — the top-left chat, after bloxd.io: every message is its own small rounded translucent
// slate-blue box, only as wide as its text (up to 40 % of the screen), "Name: message" with a gold [Host] tag for
// the host, system lines (joins, leaves, deaths, command feedback) in yellow / gray / red without a name. T, Enter
// or "/" open it: the input bar appears under the messages, the whole history shows with a scrollbar, the mouse is
// free and game keys are ignored while the game keeps running. Enter sends (a line starting with "/" runs a
// command), Esc closes, ↑ / ↓ recall sent messages, Tab completes commands. Closed, the last 10 messages show and
// each fades out about 10 s after it arrived. The last 100 messages are kept per session (never saved). Every piece
// of text goes through textContent — names and messages can never run HTML. A line that starts with "/" opens the
// command suggestion popup above the input (CommandRegistry.suggest): every command with its usage, then the options
// of the argument being typed, a usage hint with the current argument marked and red hints for invalid words; Tab
// accepts the highlighted row, ↑ / ↓ move the highlight while it is open (closed, they recall sent messages), Esc
// closes the popup first, a click accepts a row. Command replies may carry clickable coordinates that copy "X Y Z".
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
    this.input.addEventListener('input', () => { this.sentIndex = -1; this.suggestSuppressed = false; this.refreshSuggestions(); });
    // ---- the command suggestion popup ----
    this.suggestBox = document.getElementById('chat-suggest');
    this.suggestHint = document.getElementById('chat-suggest-hint');
    this.suggestList = document.getElementById('chat-suggest-list');
    /** The last CommandRegistry.suggest result shown, its rows' elements, the highlighted row. */
    this.suggestion = null; this.suggestRows = []; this.suggestIndex = 0;
    /** True after Esc closed the popup: it stays closed until the text changes. */
    this.suggestSuppressed = false;
    if (this.suggestList) this.suggestList.addEventListener('mousedown', (e) => { e.preventDefault(); const row = e.target.closest('.chat-suggest-row'); if (row) this.acceptSuggestion(+row.dataset.index); });
  }

  /** Is the suggestion popup showing? */
  get suggestOpen() { return !!this.suggestBox && !this.suggestBox.classList.contains('hidden'); }

  /** Rebuild the popup for the current input text (shown only for a line starting with "/"). */
  refreshSuggestions() {
    if (!this.suggestBox) return;
    const value = this.input.value;
    if (!this.isOpen || this.suggestSuppressed || !value.startsWith('/') || !this.game.commands || !this.game.commands.suggest) { this._hideSuggestions(); return; }
    const s = this.game.commands.suggest(value);
    this.suggestion = s;
    this.suggestHint.textContent = '';
    this.suggestHint.classList.toggle('error', !!s.error);
    if (s.error) this.suggestHint.textContent = s.error;
    else if (s.hint) { const b = document.createElement('span'); b.textContent = s.hint.before; const c = document.createElement('span'); c.className = 'current'; c.textContent = s.hint.current; const a = document.createElement('span'); a.textContent = s.hint.after; this.suggestHint.append(b, c, a); }
    else this.suggestHint.textContent = s.items.length ? 'Commands — Tab accepts, ↑ ↓ choose' : '';
    this.suggestList.textContent = '';
    this.suggestRows = [];
    s.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'chat-suggest-row' + (it.disabled ? ' disabled' : '');
      row.dataset.index = String(i);
      const label = document.createElement('span'); label.className = 'label'; label.textContent = it.label;
      row.appendChild(label);
      const detailText = it.disabled ? `(${it.disabled})` : it.detail;
      if (detailText) { const d = document.createElement('span'); d.className = 'detail'; d.textContent = detailText; row.appendChild(d); }
      this.suggestList.appendChild(row);
      this.suggestRows.push(row);
    });
    if (!s.items.length && !s.hint && !s.error) { this._hideSuggestions(); return; }
    this.suggestIndex = Math.min(this.suggestIndex, Math.max(0, s.items.length - 1));
    this._highlightSuggestion();
    this.suggestBox.classList.remove('hidden');
  }

  _hideSuggestions() { if (this.suggestBox) this.suggestBox.classList.add('hidden'); this.suggestion = null; this.suggestRows = []; this.suggestIndex = 0; }

  _highlightSuggestion() {
    this.suggestRows.forEach((r, i) => r.classList.toggle('selected', i === this.suggestIndex));
    const row = this.suggestRows[this.suggestIndex];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  /** Put row `i` (default: the highlighted one) into the input: the word, plus a space when more arguments follow. */
  acceptSuggestion(i = this.suggestIndex) {
    const s = this.suggestion;
    if (!s || !s.items[i]) return false;
    const it = s.items[i];
    const text = s.line.slice(0, s.replaceStart) + it.text + (it.needsSpace ? ' ' : '');
    this.input.value = text;
    this.input.setSelectionRange(text.length, text.length);
    this.suggestIndex = 0;
    this.suggestSuppressed = false;
    this.refreshSuggestions();
    return true;
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

  /**
   * A system line without a name: `kind` 'yellow' (joins, leaves, deaths), 'gray' (command feedback) or 'red' (errors).
   * `text` may be an array of segments { text, bold?, copy? }: a `copy` segment is clickable and copies that text
   * (the coordinates of /locate) — every piece still goes through textContent.
   */
  system(text, kind = 'yellow') {
    const line = document.createElement('div');
    line.className = `chat-line chat-system chat-${kind}`;
    if (Array.isArray(text)) {
      for (const part of text) {
        const span = document.createElement('span');
        span.textContent = part.text;
        if (part.bold) span.classList.add('chat-bold');
        if (part.copy) {
          span.classList.add('chat-coords'); span.title = 'Click to copy ' + part.copy; span.setAttribute('role', 'button');
          const copy = String(part.copy);
          span.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.copyText(copy); });
        }
        line.appendChild(span);
      }
    } else line.textContent = text;
    this._push(line);
  }

  /** Copy to the clipboard and say so ("Copied!"); when the clipboard is unavailable the text is shown instead. */
  copyText(text) {
    const done = () => this.system('Copied!', 'gray');
    const fail = () => this.system('Could not copy — ' + text, 'red');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
      else fail();
    } catch (e) { fail(); }
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
    // Only lines whose state changes touch the DOM: opacity in 1/50 steps, hidden flag cached per line.
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
    this.suggestSuppressed = false; this.suggestIndex = 0;
    this.refreshSuggestions();
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
    this._hideSuggestions();
    this.game.input.textInputActive = false;
    this._refreshVisibility();
    this.game.onChatClosed(viaKey);
  }

  _onInputKey(e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); this._send(); this.close(true); return; }
    if (e.key === 'Escape') { e.preventDefault(); if (this.suggestOpen) { this.suggestSuppressed = true; this._hideSuggestions(); } else this.close(false); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (this.suggestOpen && this.suggestion && this.suggestion.items.length) { this.acceptSuggestion(); return; }
      if (this.suggestSuppressed) { this.suggestSuppressed = false; this.refreshSuggestions(); if (this.suggestOpen && this.suggestion && this.suggestion.items.length) this.acceptSuggestion(); return; }
      const r = this.game.commands.complete(this.input.value);
      if (r.text !== this.input.value) { this.input.value = r.text; this.input.setSelectionRange(r.text.length, r.text.length); this.refreshSuggestions(); }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.suggestOpen && this.suggestRows.length) {
        const n = this.suggestRows.length;
        this.suggestIndex = (this.suggestIndex + (e.key === 'ArrowUp' ? n - 1 : 1)) % n;
        this._highlightSuggestion();
        return;
      }
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
