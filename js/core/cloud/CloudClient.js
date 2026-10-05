// CloudClient.js — creates the Supabase client the game talks to: supabase-js v2 (loaded on demand through
// the import map, main thread only) or the in-memory MockSupabase when the page runs with `?mockcloud`.
// Nothing else in the game imports supabase-js directly.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../../config/SupabaseConfig.js';
import { MockSupabase } from './MockSupabase.js';

/** @returns {Promise<object>} a supabase-js client or a MockSupabase */
export async function createCloudClient({ mock = false } = {}) {
  if (mock) return new MockSupabase();
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
}

/** True for network-level failures (offline, DNS, CORS): "can't reach the server". */
export function isNetworkError(e) {
  if (!e) return false;
  const msg = String(e.message || e);
  return e instanceof TypeError || /Failed to fetch|NetworkError|Load failed|network/i.test(msg);
}
