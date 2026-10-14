// IceServers.js — the ICE servers for every WebRTC connection: two public STUN servers plus TURN
// relays whose short-lived credentials come from the Supabase Edge Function `turn-credentials`
// (supabase/functions/turn-credentials/index.ts: Cloudflare Realtime or Metered, chosen by the owner's TURN_PROVIDER
// secret; the provider key never reaches the browser). The credentials are cached and refreshed about ten minutes
// before they expire. TURN is optional: when the function answers { iceServers: [] } (no provider configured), is not
// deployed (404) or cannot be reached, the game quietly uses STUN only — one console.info line, no warning, no toast;
// direct and same-network connections still work. With the mock cloud the mock's `functions.invoke` answers, and no
// real STUN server is contacted.

export const STUN_SERVERS = Object.freeze(['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']);
const FUNCTION_NAME = 'turn-credentials';
const DEFAULT_TTL_SECONDS = 7200;
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;

let cache = null;      // { iceServers, expiresAt, turn, note }
let inflight = null;   // the request in progress, shared by concurrent callers
let noted = false;

/** Forget the cached credentials (tests, logout). */
export function resetIceServers() { cache = null; inflight = null; noted = false; }

function stunOnly(mock) { return mock ? [] : STUN_SERVERS.map((urls) => ({ urls })); }

function normalize(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : [list]) {
    if (!s || !s.urls) continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && /^(stun|stuns|turn|turns):/.test(u));
    if (!urls.length) continue;
    const entry = { urls };
    if (s.username) entry.username = String(s.username);
    if (s.credential) entry.credential = String(s.credential);
    out.push(entry);
  }
  return out;
}

/**
 * STUN + TURN servers for a new RTCPeerConnection. `turn` says whether a relay is in the list; `note` is the one-line
 * reason when there is none (already printed once with console.info; never shown in the UI).
 * @returns {Promise<{ iceServers: RTCIceServer[], turn: boolean, note: string|null }>}
 */
export async function getIceServers(cloud, { mock = false } = {}) {
  const now = Date.now();
  if (cache && cache.expiresAt - REFRESH_MARGIN_MS > now) return { iceServers: cache.iceServers, turn: cache.turn, note: cache.note };
  if (!inflight) inflight = fetchTurn(cloud, mock).finally(() => { inflight = null; });
  return inflight;
}

/** The cached answer (F3): null before the first request. */
export function iceStatus() { return cache ? { turn: cache.turn, note: cache.note } : null; }

function stunOnlyResult(stun, note, ttlMs) {
  if (!noted) { noted = true; console.info(`CraftOn net: ${note}; using STUN only (direct and same-network connections work, strict networks may not).`); }
  cache = { iceServers: stun, expiresAt: Date.now() + ttlMs, turn: false, note };
  return { iceServers: stun, turn: false, note };
}

async function fetchTurn(cloud, mock) {
  const stun = stunOnly(mock);
  try {
    if (!cloud || !cloud.functions || typeof cloud.functions.invoke !== 'function') return stunOnlyResult(stun, 'no Edge Function client', 10 * MIN_TTL_MS);
    const res = await cloud.functions.invoke(FUNCTION_NAME, { method: 'POST', body: {} });
    if (res.error) {
      const status = res.error.context && res.error.context.status || res.error.status;
      const why = status === 404 ? 'the turn-credentials function is not deployed' : `turn-credentials failed (${res.error.message || res.error.name || 'error'})`;
      return stunOnlyResult(stun, why, 10 * MIN_TTL_MS); // retried after ten minutes
    }
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    const ttlMs = Math.max(MIN_TTL_MS, (Number(data.ttl) || DEFAULT_TTL_SECONDS) * 1000);
    const turn = normalize(data.iceServers).filter((s) => s.urls.some((u) => /^turns?:/.test(u)));
    if (!turn.length) return stunOnlyResult(stun, 'no TURN relay configured on the server', ttlMs); // { iceServers: [] }: the owner chose no relay
    const iceServers = [...stun, ...turn];
    cache = { iceServers, expiresAt: Date.now() + ttlMs, turn: true, note: null };
    return { iceServers, turn: true, note: null };
  } catch (e) {
    return stunOnlyResult(stun, `turn-credentials could not be reached (${e && e.message ? e.message : e})`, 10 * MIN_TTL_MS);
  }
}
