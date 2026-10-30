// SlotClick.js — the Minecraft click semantics between a slot and the cursor stack as a pure function, shared by the
// inventory screen (every space: the inventory, a chest) and the host, which applies a guest's chest clicks with the
// guest's reported cursor. Returns the new { slot, cursor } (ItemStacks or null); the inputs are not mutated.

import { ItemStack } from './ItemStack.js';

/**
 * @param {ItemStack|null} slot the stack in the slot
 * @param {ItemStack|null} cursor the stack on the mouse
 * @param {0|2} button left: pick up / put down / merge / swap; right: split / place one
 */
export function clickSlot(slot, cursor, button) {
  const s = slot ? slot.clone() : null, c = cursor ? cursor.clone() : null;
  if (button === 0) {
    if (!c) return { slot: null, cursor: s };
    if (!s) return { slot: c, cursor: null };
    if (s.canMergeWith(c)) { s.absorb(c); return { slot: s, cursor: c.count > 0 ? c : null }; }
    return { slot: c, cursor: s };
  }
  if (button === 2) {
    if (!c) { if (!s) return { slot: null, cursor: null }; const half = s.splitHalf(); return { slot: s.count > 0 ? s : null, cursor: half }; }
    if (!s) { const one = c.take(1); return { slot: one, cursor: c.count > 0 ? c : null }; }
    if (s.canMergeWith(c) && s.count < s.maxStack) { s.count++; c.count--; return { slot: s, cursor: c.count > 0 ? c : null }; }
    if (!s.canMergeWith(c)) return { slot: c, cursor: s };
  }
  return { slot: s, cursor: c };
}

/** Put up to `n` of `itemId` into `slot` (empty or the same item): returns { slot, accepted }. */
export function putIntoSlot(slot, itemId, n) {
  if (!slot) { const take = Math.min(n, new ItemStack(itemId, 1).maxStack); return { slot: new ItemStack(itemId, take), accepted: take }; }
  if (slot.itemId !== itemId) return { slot, accepted: 0 };
  const s = slot.clone(); const take = Math.min(n, s.maxStack - s.count); s.count += take;
  return { slot: s, accepted: take };
}
