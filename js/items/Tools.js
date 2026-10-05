// Tools.js — mining speed and attack damage rules for held items, plus the tooltip stat lines. Pure.

import { ItemRegistry } from './ItemRegistry.js';
import { BREAK_TIME, STONE_TYPE, WOOD_TYPE } from '../blocks/BlockRegistry.js';
import { HAND_ATTACK_DAMAGE } from '../config/Constants.js';

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

/** Minecraft-style stat lines for tooltips: [{ text, color: 'green' | 'gray' }]. Empty for plain items. */
export function itemStatLines(itemId) {
  const lines = [];
  const armor = itemId != null ? ItemRegistry.armor(itemId) : null;
  if (armor) lines.push({ text: `+${armor.points} Armor`, color: 'green' });
  const tool = itemId != null ? ItemRegistry.tool(itemId) : null;
  if (!tool) return lines;
  const bonus = (tool.damage || HAND_ATTACK_DAMAGE) - HAND_ATTACK_DAMAGE;
  if (bonus > 0) lines.push({ text: `+${bonus} Attack Damage`, color: 'green' });
  if (tool.type === 'pickaxe') lines.push({ text: `Mining Speed \u00d7${tool.speed} (stone blocks)`, color: 'gray' });
  if (tool.type === 'axe') lines.push({ text: `Mining Speed \u00d7${tool.speed} (wood blocks)`, color: 'gray' });
  return lines;
}
