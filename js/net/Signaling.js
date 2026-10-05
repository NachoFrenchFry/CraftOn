// Signaling.js — the one-time WebRTC handshake through the `signals` table with plain REST calls (never
// Supabase Realtime): the guest inserts one `offer` row for the lobby's host and polls about every 750 ms for
// the `answer` (or `reject`) row addressed to it; the host polls for offers while its lobby is open. Rows are
// deleted as soon as they are read. Non-trickle ICE keeps it to one offer and one answer.

const POLL_MS = 750;

function check(res, what) {
  if (res && res.error) { const e = new Error(`${what}: ${res.error.message || res.error}`); e.cause = res.error; throw e; }
  return res ? res.data : null;
}

export class Signaling {
  /** @param {object} client supabase-js or MockSupabase; @param {string} userId the local user id */
  constructor(client, userId) {
    this.client = client;
    this.userId = userId;
  }

  async send(lobbyId, toUser, kind, payload) {
    check(await this.client.from('signals').insert({ lobby_id: lobbyId, to_user: toUser, kind, payload }), 'send signal');
  }

  /** Rows addressed to me of the given kinds (deleted after reading). */
  async take(lobbyId, kinds) {
    const rows = check(await this.client.from('signals').select('id, lobby_id, from_user, to_user, kind, payload, created_at').eq('lobby_id', lobbyId).eq('to_user', this.userId), 'read signals') || [];
    const mine = rows.filter((r) => kinds.includes(r.kind));
    for (const r of mine) { try { await this.client.from('signals').delete().eq('id', r.id); } catch (e) { /* best effort */ } }
    return mine;
  }

  /**
   * Poll for a row of the given kinds until one arrives or the deadline passes (resolves null on timeout).
   * `isCancelled()` stops the loop early.
   */
  async waitFor(lobbyId, kinds, timeoutMs, isCancelled = () => false) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !isCancelled()) {
      const rows = await this.take(lobbyId, kinds);
      if (rows.length) return rows[0];
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return null;
  }

  /** Remove every signal row I sent or received for a lobby (leaving / stopping). */
  async clear(lobbyId) {
    try {
      const rows = check(await this.client.from('signals').select('id, from_user, to_user').eq('lobby_id', lobbyId), 'read signals') || [];
      for (const r of rows) if (r.from_user === this.userId || r.to_user === this.userId) await this.client.from('signals').delete().eq('id', r.id);
    } catch (e) { /* best effort */ }
  }
}

export { POLL_MS as SIGNAL_POLL_MS };
