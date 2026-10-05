// SupabaseConfig.js — the only place the Supabase project details appear (Update #6). The publishable key
// is designed to be public in client code; security comes from Row Level Security on the server.
// NEVER put a secret or service_role key anywhere in this project.

export const SUPABASE_URL = 'https://senvqocxoblsbjrvgdxc.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_kCOVBQfMPEJfC08Yb9sDOw_PyAO9Nz9';

/**
 * Accounts are username-only. Supabase Auth needs an email, so a hidden placeholder address is built as
 * `username.toLowerCase() + '@' + PSEUDO_EMAIL_DOMAIN`. No mail is ever sent (confirmation is off) and the
 * address is never shown to the player. If Supabase rejects the format, change the domain here.
 */
export const PSEUDO_EMAIL_DOMAIN = 'players.crafton.app';

/** Username rule shared by the UI and the server (unique case-insensitively). */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
export const PASSWORD_MIN_LENGTH = 8;
