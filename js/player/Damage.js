// Damage.js — the health numbers (Update #9 §8), pure so Node checks can print them: 100 health, +1 every 7 s,
// gentle fall damage with armor (boots count double), player-vs-player damage scaled ×5 with armor reduction
// and critical hits, and the death messages.

export const MAX_HEALTH = 100;
export const REGEN_SECONDS = 7;
export const INVULNERABLE_SECONDS = 0.5;
/** Host-side reach for a player hit (blocks between the attacker's eyes and the victim's box), plus latency slack. */
export const PVP_REACH = 3.5;
export const PVP_REACH_SLACK = 1.5;
export const PVP_DAMAGE_SCALE = 5;
export const CRIT_MULTIPLIER = 1.5;
export const EAT_SECONDS = 1.6;
export const RESPAWN_INVULNERABLE_SECONDS = 2;
// Lava and fire (Update #11): 20 every 0.5 s while in lava (lethal in about 2.5 s unarmored), then 5 s on fire at 5 per second.
export const LAVA_DAMAGE = 20;
export const LAVA_DAMAGE_INTERVAL = 0.5;
export const FIRE_SECONDS = 5;
export const FIRE_DAMAGE = 5;
export const FIRE_INTERVAL = 1;

/** Lava / fire damage after armor (the usual formula, boots count once). */
export function lavaDamage(armorPoints = 0) { return Math.max(1, Math.round(LAVA_DAMAGE * armorReduction(armorPoints))); }
export function fireDamage(armorPoints = 0) { return Math.max(1, Math.round(FIRE_DAMAGE * armorReduction(armorPoints))); }
/** Seconds a full-health player survives standing in lava with that armor. */
export function lavaSurvivalSeconds(armorPoints = 0) { return Math.ceil(MAX_HEALTH / lavaDamage(armorPoints)) * LAVA_DAMAGE_INTERVAL; }

/** Fraction of damage that gets through `points` of armor: 3 % per point, at most 70 % blocked. */
export function armorReduction(points) { return 1 - Math.min(0.7, Math.max(0, points) * 0.03); }

/** Raw fall damage before armor: nothing up to 3 blocks, then 2.15 per block, rounded (50 blocks ≈ 101). */
export function rawFallDamage(fallDistance) { return Math.round(Math.max(0, fallDistance - 3) * 2.15); }

/** Fall damage after armor; `bootsPoints` are the boots' points, counted a second time (boots count double). */
export function fallDamage(fallDistance, armorPoints = 0, bootsPoints = 0) {
  const raw = rawFallDamage(fallDistance);
  return raw <= 0 ? 0 : Math.round(raw * armorReduction(armorPoints + bootsPoints));
}

/** Smallest whole fall (blocks) that kills a 100-health player with that armor. */
export function lethalFall(armorPoints = 0, bootsPoints = 0) {
  for (let f = 3; f < 2000; f++) if (fallDamage(f, armorPoints, bootsPoints) >= MAX_HEALTH) return f;
  return Infinity;
}

/** Player-vs-player damage: the item's attack damage ×5, ×1.5 on a critical hit, reduced by the victim's armor. */
export function pvpDamage(attackDamage, crit, victimArmorPoints = 0) {
  return Math.max(0, Math.round(attackDamage * PVP_DAMAGE_SCALE * (crit ? CRIT_MULTIPLIER : 1) * armorReduction(victimArmorPoints)));
}

/** Death causes: { kind: 'fall' | 'void' | 'pvp' | 'lava' | 'fire', by }. */
export function causeText(cause) {
  if (!cause) return 'Died';
  if (cause.kind === 'fall') return 'Fell from a high place';
  if (cause.kind === 'void') return 'Fell out of the world';
  if (cause.kind === 'pvp') return `Slain by ${cause.by || 'another player'}`;
  if (cause.kind === 'lava') return 'Tried to swim in lava';
  if (cause.kind === 'fire') return 'Burned to death';
  return 'Died';
}

/** The toast other players see: "Bob fell from a high place", "Bob was slain by Alice". */
export function deathMessage(name, cause) {
  if (!cause) return `${name} died`;
  if (cause.kind === 'fall') return `${name} fell from a high place`;
  if (cause.kind === 'void') return `${name} fell out of the world`;
  if (cause.kind === 'pvp') return `${name} was slain by ${cause.by || 'another player'}`;
  if (cause.kind === 'lava') return `${name} tried to swim in lava`;
  if (cause.kind === 'fire') return `${name} burned to death`;
  return `${name} died`;
}
