// Tools.js — mining speed and attack damage rules for held items, plus the tooltip lines (number stats + one description). Pure.

import { ItemRegistry } from './ItemRegistry.js';
import { BREAK_TIME, STONE_TYPE, WOOD_TYPE } from '../blocks/BlockRegistry.js';
import { HAND_ATTACK_DAMAGE } from '../config/Constants.js';
import { HAND_KNOCKBACK } from './ItemDefinitions.js';

export const HAND_SPEED = 1;

/** Speed multiplier for mining `blockId` while holding `itemId` (-1 / null = empty hand). */
export function miningSpeed(blockId, itemId) {
  const tool = itemId != null ? ItemRegistry.tool(itemId) : null;
  if (tool && tool.type === 'pickaxe' && STONE_TYPE[blockId] === 1) return tool.speed;
  if (tool && tool.type === 'axe' && WOOD_TYPE[blockId] === 1) return tool.speed;
  return HAND_SPEED;
}

/** Seconds to break a block with the held item (Infinity for unbreakable, 0 for instant). */
export function effectiveBreakTime(blockId, itemId) {
  const base = BREAK_TIME[blockId];
  if (!isFinite(base) || base <= 0) return base;
  return base / miningSpeed(blockId, itemId);
}

/** Damage dealt to a mob with the held item (the empty hand deals HAND_ATTACK_DAMAGE). */
export function attackDamage(itemId) {
  const tool = itemId != null ? ItemRegistry.tool(itemId) : null;
  return tool && tool.damage ? tool.damage : HAND_ATTACK_DAMAGE;
}

export function isSword(itemId) {
  const tool = itemId != null ? ItemRegistry.tool(itemId) : null;
  return !!(tool && tool.type === 'sword');
}

/** The mace: velocity-based damage and smash attacks (Damage.js); mines like the hand, never breaks blocks in Creative. */
export function isMace(itemId) {
  const tool = itemId != null ? ItemRegistry.tool(itemId) : null;
  return !!(tool && tool.type === 'mace');
}

/** Spears: damage from the horizontal closing speed (Damage.js); like swords otherwise (reach, knockback, no block breaking in Creative). */
export function isSpear(itemId) {
  const tool = itemId != null ? ItemRegistry.tool(itemId) : null;
  return !!(tool && tool.type === 'spear');
}

export function isBow(itemId) { return itemId != null && ItemRegistry.isBow(itemId); }
export function isGlider(itemId) { return itemId != null && ItemRegistry.isGlider(itemId); }
export function isRocket(itemId) { return itemId != null && ItemRegistry.isRocket(itemId); }

/** Knockback points of a hit with the held item (hand 5, stick 10); the knockback strength is points / 5 times the usual. */
export function knockbackPoints(itemId) { return itemId != null ? ItemRegistry.knockback(itemId) : HAND_KNOCKBACK; }
export function knockbackScale(itemId) { return knockbackPoints(itemId) / HAND_KNOCKBACK; }

/**
 * Tooltip lines: the plain green number stats (`+N Attack Damage`, `+N Armor`, `+N Knockback`, `+N Health`) and then the item's
 * one short gray description from its definition (what it does, never how to use it). Empty for blocks and materials.
 */
export function itemStatLines(itemId) {
  const lines = [];
  if (itemId == null) return lines;
  const tool = ItemRegistry.tool(itemId);
  const bonus = tool ? (tool.damage || HAND_ATTACK_DAMAGE) - HAND_ATTACK_DAMAGE : 0;
  if (bonus > 0) lines.push({ text: `+${bonus} Attack Damage`, color: 'green' });
  const armor = ItemRegistry.armor(itemId);
  if (armor) lines.push({ text: `+${armor.points} Armor`, color: 'green' });
  const kb = knockbackPoints(itemId) - HAND_KNOCKBACK;
  if (kb !== 0) lines.push({ text: `${kb > 0 ? '+' : ''}${kb} Knockback`, color: 'green' }); // only items whose knockback differs from the hand
  const food = ItemRegistry.food(itemId);
  if (food) lines.push({ text: `+${food.heal} Health`, color: 'green' });
  const description = ItemRegistry.description(itemId);
  if (description) lines.push({ text: description, color: 'gray' });
  return lines;
}
