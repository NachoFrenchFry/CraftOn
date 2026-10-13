// turn-credentials — Supabase Edge Function (Deno) for CraftOn, Update #15.
//
// Hands a logged-in player short-lived TURN credentials so two browsers behind strict routers can still connect (the
// relay is used only when a direct connection fails). The provider's key never leaves this function.
//
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function → Via Editor, name it `turn-credentials`, paste this
// file, keep "Verify JWT" ON (only logged-in players may call it) and deploy. Secrets (Edge Functions → Secrets):
//   TURN_PROVIDER              "cloudflare" or "metered" (unset = no relay: the function answers { iceServers: [] })
//   CLOUDFLARE_TURN_KEY_ID     Cloudflare → Realtime → TURN Server → the key id        (TURN_PROVIDER=cloudflare)
//   CLOUDFLARE_TURN_API_TOKEN  its API token                                           (TURN_PROVIDER=cloudflare)
//   METERED_APP_NAME           Metered (Open Relay / TURN) → the app name, <app>.metered.live   (TURN_PROVIDER=metered)
//   METERED_API_KEY            the app's API key                                       (TURN_PROVIDER=metered)
// Response: { iceServers: [{ urls: [...], username, credential }], ttl, provider } — URLs on port 53 are removed (browsers
// refuse them). Without a configured provider the answer is { iceServers: [], ttl, provider: null } and the game quietly
// uses STUN only; so does a game whose project never deployed this function (404).
// Errors: JSON { error } with 401 / 405 / 429 / 502; the secrets are never logged.

const CLOUDFLARE_TTL_SECONDS = 7200;
/** Metered's credentials endpoint hands out the app's standing credential; the client re-fetches it hourly anyway. */
const METERED_TTL_SECONDS = 3600;
const RATE_LIMIT = 10; // requests per user per minute
const ALLOWED_ORIGINS = [/^https:\/\/crafton\.pages\.dev$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

type IceServer = { urls: string[]; username?: string; credential?: string };
type RawServer = { urls?: string | string[]; username?: string; credential?: string };

const requests = new Map<string, number[]>(); // user id → request timestamps within the last minute (per instance)

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.some((re) => re.test(origin)) ? origin : 'https://crafton.pages.dev';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
}

/** The user id (`sub`) of the verified JWT in the Authorization header; the platform already checked the signature. */
function userIdOf(req: Request): string | null {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const list = (requests.get(userId) || []).filter((t) => now - t < 60_000);
  if (list.length >= RATE_LIMIT) { requests.set(userId, list); return true; }
  list.push(now);
  requests.set(userId, list);
  if (requests.size > 10_000) requests.clear(); // never grow without bound
  return false;
}

/** True for a TURN / STUN URL on port 53 (DNS), which browsers refuse to use. */
function usesPort53(url: string): boolean {
  const m = /^(?:stun|stuns|turn|turns):[^:?]+:(\d+)(?:\?|$)/i.exec(url);
  return !!m && m[1] === '53';
}

/** One object or a list of { urls, username, credential } → a clean list without port-53 URLs. */
function normalize(raw: unknown): IceServer[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: IceServer[] = [];
  for (const s of list as RawServer[]) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : s.urls ? [s.urls] : []).filter((u) => typeof u === 'string' && !usesPort53(u));
    if (!urls.length) continue;
    const entry: IceServer = { urls };
    if (s.username) entry.username = String(s.username);
    if (s.credential) entry.credential = String(s.credential);
    out.push(entry);
  }
  return out;
}

class ProviderError extends Error {}

/** Cloudflare Realtime: POST .../turn/keys/{id}/credentials/generate-ice-servers { ttl } → { iceServers: {...} | [...] }. */
async function cloudflare(): Promise<{ iceServers: IceServer[]; ttl: number }> {
  const keyId = Deno.env.get('CLOUDFLARE_TURN_KEY_ID');
  const apiToken = Deno.env.get('CLOUDFLARE_TURN_API_TOKEN');
  if (!keyId || !apiToken) throw new ProviderError('TURN_PROVIDER is cloudflare but CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN are not set');
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CLOUDFLARE_TTL_SECONDS }),
  });
  if (!res.ok) throw new ProviderError(`Cloudflare answered ${res.status}`);
  const data = await res.json() as { iceServers?: unknown };
  return { iceServers: normalize(data.iceServers), ttl: CLOUDFLARE_TTL_SECONDS };
}

/** Metered (Open Relay / TURN): GET https://<app>.metered.live/api/v1/turn/credentials?apiKey=… → [{ urls, username, credential }, …]. */
async function metered(): Promise<{ iceServers: IceServer[]; ttl: number }> {
  const app = Deno.env.get('METERED_APP_NAME');
  const apiKey = Deno.env.get('METERED_API_KEY');
  if (!app || !apiKey) throw new ProviderError('TURN_PROVIDER is metered but METERED_APP_NAME / METERED_API_KEY are not set');
  if (!/^[a-z0-9-]+$/i.test(app)) throw new ProviderError('METERED_APP_NAME must be the bare app name (the part before .metered.live)');
  const res = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`);
  if (!res.ok) throw new ProviderError(`Metered answered ${res.status}`);
  return { iceServers: normalize(await res.json()), ttl: METERED_TTL_SECONDS };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json(405, { error: 'Use POST' }, origin);

  const userId = userIdOf(req);
  if (!userId) return json(401, { error: 'Not logged in' }, origin);
  if (rateLimited(userId)) return json(429, { error: 'Too many requests: at most 10 per minute' }, origin);

  const provider = (Deno.env.get('TURN_PROVIDER') || '').trim().toLowerCase();
  if (!provider) return json(200, { iceServers: [], ttl: METERED_TTL_SECONDS, provider: null }, origin); // no relay configured: STUN only
  if (provider !== 'cloudflare' && provider !== 'metered') return json(502, { error: `Unknown TURN_PROVIDER "${provider}" (use cloudflare or metered)` }, origin);

  try {
    const { iceServers, ttl } = provider === 'cloudflare' ? await cloudflare() : await metered();
    if (!iceServers.length) return json(502, { error: 'The TURN provider returned no usable servers' }, origin);
    return json(200, { iceServers, ttl, provider }, origin);
  } catch (e) {
    const message = e instanceof ProviderError ? e.message : 'Could not reach the TURN provider';
    console.error('turn-credentials:', message); // never the key or token
    return json(502, { error: message }, origin);
  }
});
