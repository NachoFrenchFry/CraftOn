// Zombie.js — the hostile mob: a humanoid in the 64×64 player skin layout (textures/entity/zombie.png, see
// js/player/models/SkinLayout.js) that spawns only in complete darkness, chases the nearest Survival player within
// 24 blocks at about 2.3 blocks/s, hits for 15 (before armor) once a second within 1.2 blocks, never burns in daylight,
// drops nothing and is never saved. Arms stretched forward; MobManager / ZombieAI drive it.

import { SKIN_PARTS, SKIN_SIZE } from '../../player/models/SkinLayout.js';
import { ZOMBIE_CHASE_RANGE, ZOMBIE_ATTACK_RANGE, ZOMBIE_ATTACK_DAMAGE, ZOMBIE_ATTACK_COOLDOWN } from '../../config/Constants.js';

export const ZOMBIE = Object.freeze({
  type: 'zombie',
  displayName: 'Zombie',
  texture: 'zombie',
  sheet: SKIN_SIZE,
  hostile: true,
  health: 20,
  hitbox: [0.6, 1.95],
  walkSpeed: 2.3,
  panicSpeed: 2.3,
  chaseRange: ZOMBIE_CHASE_RANGE,
  attackRange: ZOMBIE_ATTACK_RANGE,
  attackDamage: ZOMBIE_ATTACK_DAMAGE,
  attackCooldown: ZOMBIE_ATTACK_COOLDOWN,
  sounds: { ambient: 'mob.zombie', hurt: 'mob.zombie_hurt', death: 'mob.zombie_death' },
  ambientInterval: [6, 20],
  drops: [],
  // The skin layout's boxes verbatim (pivot = joint in pixels up from the feet, offset = box centre from the pivot).
  parts: SKIN_PARTS.map((p) => ({ name: p.name, size: p.size, uv: p.uv, pivot: p.pivot, offset: p.offset })),
});
