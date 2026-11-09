// Damage.js — the health numbers, pure so Node checks can print them: 100 health, +1 every 7 s,
// gentle fall damage with armor (boots count double), player-vs-player damage (the item's attack damage, a 1.5× critical
// hit, the victim's armor), the mace's and the spears' velocity-based damage, and the death messages. Every weapon deals
// and shows one real number (Nov 6 2026: the hidden ×5 player scale is gone; mobs have five times the health instead, so
// every hits-to-kill count is what it was).

import { GRAVITY, TERMINAL_VELOCITY } from '../config/Constants.js';

export const MAX_HEALTH = 100;
export const REGEN_SECONDS = 7;
export const INVULNERABLE_SECONDS = 0.5;
/** Host-side reach for a player hit (blocks between the attacker's eyes and the victim's box), plus latency slack. */
export const PVP_REACH = 3.5;
export const PVP_REACH_SLACK = 1.5;
export const CRIT_MULTIPLIER = 1.5;
export const EAT_SECONDS = 1.6;
export const RESPAWN_INVULNERABLE_SECONDS = 2;
// Lava and fire: 20 every 0.5 s while in lava (lethal in about 2.5 s unarmored), then 5 s on fire at 5 per second.
export const LAVA_DAMAGE = 20;
export const LAVA_DAMAGE_INTERVAL = 0.5;
export const FIRE_SECONDS = 5;
export const FIRE_DAMAGE = 5;
export const FIRE_INTERVAL = 1;
/**
 * Mobs in lava and on fire (MobManager._lavaAndFire): the player's timing with the mob numbers, so mobs die as fast as
 * before their health went ×5 — one lava tick kills any mob, burning kills a chicken in 1 tick, a cow in 2, a zombie in 4.
 * The player's values stay 20 and 5.
 */
export const MOB_LAVA_DAMAGE = 100;
export const MOB_FIRE_DAMAGE = 25;

/** Lava / fire damage after armor (the usual formula, boots count once). */
export function lavaDamage(armorPoints = 0) { return Math.max(1, Math.round(LAVA_DAMAGE * armorReduction(armorPoints))); }
export function fireDamage(armorPoints = 0) { return Math.max(1, Math.round(FIRE_DAMAGE * armorReduction(armorPoints))); }
/** Seconds a full-health player survives standing in lava with that armor. */
export function lavaSurvivalSeconds(armorPoints = 0) { return Math.ceil(MAX_HEALTH / lavaDamage(armorPoints)) * LAVA_DAMAGE_INTERVAL; }

/** Fraction of damage that gets through `points` of armor: 3 % per point, at most 70 % blocked. */
export function armorReduction(points) { return 1 - Math.min(0.7, Math.max(0, points) * 0.03); }

/**
 * Explosions (Nov 8 2026): the same 3 % per point on the *explosion* armor points — obsidian pieces count 1.5× there
 * (ItemDefinitions.armorPointsFor(materials, { explosion: true })) — with its own cap of 85 %. The cap only matters with
 * obsidian: full diamond's 23 points still block 69 %, full obsidian's 34.5 would block 103 % and stop at 85 %.
 */
export const EXPLOSION_ARMOR_CAP = 0.85;
export function explosionArmorReduction(explosionPoints) { return 1 - Math.min(EXPLOSION_ARMOR_CAP, Math.max(0, explosionPoints) * 0.03); }

/** Raw fall damage before armor: nothing up to 3 blocks, then 2.15 per block, rounded (50 blocks ≈ 101). */
export function rawFallDamage(fallDistance) { return Math.round(Math.max(0, fallDistance - 3) * 2.15); }

/** Fall damage after armor; `bootsPoints` are the boots' points, counted a second time (boots count double). */
export function fallDamage(fallDistance, armorPoints = 0, bootsPoints = 0) {
  const raw = rawFallDamage(fallDistance);
  return raw <= 0 ? 0 : Math.round(raw * armorReduction(armorPoints + bootsPoints));
}

/** Mob fall damage: the player's curve on the mob's health scale, max(0, fall − 3) × 1.075 (a 50-health cow dies from about 50 blocks). */
export function mobFallDamage(fallDistance) { return Math.max(0, fallDistance - 3) * 1.075; }

/** Smallest whole fall (blocks) that kills a 100-health player with that armor. */
export function lethalFall(armorPoints = 0, bootsPoints = 0) {
  for (let f = 3; f < 2000; f++) if (fallDamage(f, armorPoints, bootsPoints) >= MAX_HEALTH) return f;
  return Infinity;
}

/** Player-vs-player damage: the item's attack damage (the number its tooltip shows), ×1.5 on a critical hit, reduced by the victim's armor. */
export function pvpDamage(attackDamage, crit, victimArmorPoints = 0) {
  return Math.max(0, Math.round(attackDamage * (crit ? CRIT_MULTIPLIER : 1) * armorReduction(victimArmorPoints)));
}

// ---- The mace: damage from the vertical closing speed, smash attacks and the wind burst ----
/** Base damage (a standing hit): the same number as the item's `tool.damage` and its tooltip. */
export const MACE_BASE_DAMAGE = 25;
/** The "decimal": each block/s of closing speed adds MACE_VELOCITY_FACTOR × MACE_DAMAGE_PER_UNIT (2.5) damage. Tune these three to rebalance. */
export const MACE_VELOCITY_FACTOR = 0.05;
export const MACE_DAMAGE_PER_UNIT = 50;
/** Closing speed of a smash attack: the speed after a 1.5-block fall, √(2 × GRAVITY 32 × 1.5) ≈ 9.8 blocks/s. */
export const MACE_SMASH_SPEED = 9.8;
/** The wind burst: the attacker's velocity.y after a smash (23.5 ≈ 8.6 blocks up with gravity 32, about 0.73 s to the peak; was 21 ≈ 7 blocks). */
export const MACE_BURST_VELOCITY = 23.5;
/** Both velocities are clamped to ±TERMINAL_VELOCITY before the formula, so the damage tops out at 25 + 156 × 2.5 = 415 (to a mob or an unarmored player alike). */
export const MACE_VELOCITY_CLAMP = TERMINAL_VELOCITY;

export function clampMaceVelocity(vy) { const v = Number(vy) || 0; return Math.max(-MACE_VELOCITY_CLAMP, Math.min(MACE_VELOCITY_CLAMP, v)); }
/** Closing speed: how fast the attacker comes down onto the target, relative to it (y is up, falling is negative); 0 when not closing in. */
export function maceClosingSpeed(attackerVy, targetVy) { return Math.max(0, clampMaceVelocity(targetVy) - clampMaceVelocity(attackerVy)); }
/** Mace damage before armor: what a mob takes. */
export function maceDamage(closingSpeed) { return MACE_BASE_DAMAGE + Math.max(0, closingSpeed) * (MACE_VELOCITY_FACTOR * MACE_DAMAGE_PER_UNIT); } // the constants' product first: 0.05 × 50 = 2.5 exactly
/** A smash attack: closing at MACE_SMASH_SPEED or more (the "fell more than 1.5 blocks" rule, as a speed). */
export function isMaceSmash(closingSpeed) { return closingSpeed >= MACE_SMASH_SPEED; }
/** Mace damage to a player: the victim's armor on top; no 1.5× critical multiplier (the velocity bonus replaces it). */
export function macePlayerDamage(closingSpeed, victimArmorPoints = 0) { return Math.max(0, Math.round(maceDamage(closingSpeed) * armorReduction(victimArmorPoints))); }
/** Speed after falling `blocks` from rest, √(2 × GRAVITY × blocks), capped at the terminal velocity (for tables and tests). */
export function fallSpeedAfter(blocks) { return Math.min(TERMINAL_VELOCITY, Math.sqrt(2 * GRAVITY * Math.max(0, blocks))); }

// ---- Spears: damage from the horizontal closing speed, relative to the target ----
/** The "decimal": each block/s of closing speed adds SPEAR_VELOCITY_FACTOR × SPEAR_DAMAGE_PER_UNIT (2.5) damage. */
export const SPEAR_VELOCITY_FACTOR = 0.05;
export const SPEAR_DAMAGE_PER_UNIT = 50;
/** A hit closing at this speed or more is a "fast hit": the crit stars and the crit sound (there is no 1.5× multiplier). */
export const SPEAR_FAST_SPEED = 8;
/** Velocity components are clamped to this before the formula: the fastest a player moves horizontally (a rocket dash is 20, a rocket-boosted dive a little more). */
export const SPEAR_VELOCITY_CLAMP = 30;

export function clampSpearVelocity(v) { const n = Number(v) || 0; return Math.max(-SPEAR_VELOCITY_CLAMP, Math.min(SPEAR_VELOCITY_CLAMP, n)); }
/** Unit horizontal vector from the attacker to the target ({ dx: 0, dz: 0 } when they share the column). */
export function horizontalDir(attackerX, attackerZ, targetX, targetZ) {
  const dx = targetX - attackerX, dz = targetZ - attackerZ, len = Math.hypot(dx, dz);
  return len > 1e-6 ? { dx: dx / len, dz: dz / len } : { dx: 0, dz: 0 };
}
/**
 * Horizontal closing speed: how fast attacker and target come together along the line between them (x / z only; `dx, dz`
 * is the unit vector from the attacker to the target). Never below 0 — running away from a target, or sideways past it,
 * counts for nothing; only the part of the relative velocity toward the target counts.
 */
export function spearClosingSpeed(attackerVx, attackerVz, targetVx, targetVz, dx, dz) {
  return Math.max(0, (clampSpearVelocity(attackerVx) - clampSpearVelocity(targetVx)) * dx + (clampSpearVelocity(attackerVz) - clampSpearVelocity(targetVz)) * dz);
}
/** Spear damage before armor (what a mob takes): the tier's base (5–25) plus 2.5 per block/s of closing speed. */
export function spearDamage(baseDamage, closingSpeed) { return baseDamage + Math.max(0, closingSpeed) * (SPEAR_VELOCITY_FACTOR * SPEAR_DAMAGE_PER_UNIT); }
export function isSpearFast(closingSpeed) { return closingSpeed >= SPEAR_FAST_SPEED; }
/** Spear damage to a player: the victim's armor on top; no 1.5× critical multiplier. */
export function spearPlayerDamage(baseDamage, closingSpeed, victimArmorPoints = 0) { return Math.max(0, Math.round(spearDamage(baseDamage, closingSpeed) * armorReduction(victimArmorPoints))); }

// ---- Zombies, arrows and explosions ----
/** A zombie's melee hit after the victim's armor (15 before it). */
export function zombieDamage(armorPoints = 0, base = 15) { return Math.max(1, Math.round(base * armorReduction(armorPoints))); }

/** Arrow damage at draw power `p` (0..1): (round(9 × p) + `bonus`) × 5 — 45 at a full draw, up to 65 with the 0–4 bonus (rolled by the caller, counted only when fully drawn). Mobs take it directly. */
export function arrowDamage(power, bonus = 0) { return (Math.round(9 * power) + (power >= 1 ? bonus : 0)) * 5; }
/** Arrow damage against a player: the same amount, reduced by armor. */
export function arrowPlayerDamage(power, bonus = 0, victimArmorPoints = 0) { return Math.max(0, Math.round(arrowDamage(power, bonus) * armorReduction(victimArmorPoints))); }
/** The bow's power curve: (t² + 2t) / 3 for the draw fraction t (1 at a full draw). */
export function bowPower(t) { t = Math.max(0, Math.min(1, t)); return (t * t + 2 * t) / 3; }

/** Minecraft's explosion impact: (1 − distance / (2 × power)) × exposure. */
export function explosionImpact(distance, exposure, power) { return Math.max(0, Math.min(1, (1 - distance / (2 * power)) * exposure)); }
/** Explosion damage before armor: Minecraft's ((impact² + impact) / 2) × 7 × power + 1 on the 100-health scale (× 5): 145 at full impact with power 4. */
export function explosionBaseDamage(impact, power) { return impact <= 0 ? 0 : (((impact * impact + impact) / 2) * 7 * power + 1) * 5; }
/** A player's explosion damage: the base reduced by the explosion armor points (obsidian ×1.5, cap 85 %): at point blank 145 bare, 45 in full diamond, 22 in full obsidian, 28 in diamond with an obsidian chestplate. */
export function explosionPlayerDamage(impact, power, explosionArmorPoints = 0) { return impact <= 0 ? 0 : Math.max(0, Math.round(explosionBaseDamage(impact, power) * explosionArmorReduction(explosionArmorPoints))); }
/** A mob's explosion damage: the base, rounded to one decimal. */
export function explosionMobDamage(impact, power) { return impact <= 0 ? 0 : Math.round(explosionBaseDamage(impact, power) * 10) / 10; }

/** Death causes: { kind: 'fall' | 'void' | 'pvp' | 'lava' | 'fire' | 'zombie' | 'arrow' | 'explosion', by }. */
export function causeText(cause) {
  if (!cause) return 'Died';
  if (cause.kind === 'fall') return 'Fell from a high place';
  if (cause.kind === 'void') return 'Fell out of the world';
  if (cause.kind === 'pvp') return `Slain by ${cause.by || 'another player'}`;
  if (cause.kind === 'lava') return 'Tried to swim in lava';
  if (cause.kind === 'fire') return 'Burned to death';
  if (cause.kind === 'zombie') return 'Slain by a Zombie';
  if (cause.kind === 'arrow') return `Shot by ${cause.by || 'another player'}`;
  if (cause.kind === 'explosion') return 'Blown up';
  if (cause.kind === 'crash') return 'Crashed while gliding';
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
  if (cause.kind === 'zombie') return `${name} was slain by a Zombie`;
  if (cause.kind === 'arrow') return `${name} was shot by ${cause.by || 'another player'}`;
  if (cause.kind === 'explosion') return `${name} was blown up`;
  if (cause.kind === 'crash') return `${name} crashed while gliding`;
  return `${name} died`;
}
