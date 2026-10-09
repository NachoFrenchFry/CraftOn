// BlockInteraction.js — mining progress with crack stages, breaking (particles, drops, sounds),
// placing with player-collision checks, pick-block, and hand swing events.

import { BlockIds } from '../blocks/BlockIds.js';
import { BlockRegistry, SOLID, BREAK_TIME, RENDER_TYPE, RenderType, PASS, RenderPass } from '../blocks/BlockRegistry.js';
import { ItemRegistry } from '../items/ItemRegistry.js';
import { EAT_SECONDS } from './Damage.js';
import { isSupported, breakDependents } from '../blocks/Support.js';
import { ItemStack } from '../items/ItemStack.js';
import { effectiveBreakTime, attackDamage, isSword } from '../items/Tools.js';
import { ItemIds } from '../items/ItemDefinitions.js';
import { RaycastHit } from './BlockRaycaster.js';
import { isSource, isLavaSource, isLiquid } from '../world/WaterLevels.js';
import { MOB_BY_TYPE } from '../entities/mobs/MobSpawner.js';
import { REACH_SURVIVAL, REACH_CREATIVE, PLACE_REPEAT_SECONDS, ATTACK_REACH } from '../config/Constants.js';

const HIT_SOUND_INTERVAL = 0.25;
const ATTACK_BLOCK_SECONDS = 0.3;
const CREATIVE_BREAK_COOLDOWN = 0.18;
const SWING_INTERVAL = 0.25;

export class BlockInteraction {
  /**
   * @param {object} deps world, player, inventory, raycaster, selectionBox, breakOverlay, particles,
   *   entities, audio, events, actions, input
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.target = new RaycastHit();
    this.lastTargetKey = null;
    this.progress = 0;
    this.mining = false;
    this.hitSoundTimer = 0;
    this.swingTimer = 0;
    this.placeTimer = 0;
    this.creativeCooldown = 0;
    this.enabled = true;
    /** Mob under the crosshair (closer than any block), or null. */
    this.targetMob = null;
    this._eye = { x: 0, y: 0, z: 0 };
    /** After an attack, mining stays blocked for ATTACK_BLOCK_SECONDS and until the button is released. */
    this.attackLockTimer = 0;
    this.attackLatched = false;
    this.mineSendTimer = 0;
    /** Eating (Update #9 §8): seconds the use button has been held with food while below max health. */
    this.eatTimer = 0;
    this.chewTimer = 0;
    /** Other player under the crosshair (multiplayer), or null. */
    this.targetPlayer = null;
  }

  get eatProgress() { return this.eatTimer > 0 ? Math.min(1, this.eatTimer / EAT_SECONDS) : 0; }

  get heldItemId() { const s = this.inventory.getSelected(); return s ? s.itemId : null; }
  /** Guest of a LAN server: the host owns mobs and drops (deps.isGuest is optional). */
  get guest() { return !!(this.isGuest && this.isGuest()); }

  get reach() { return this.player.isCreative ? REACH_CREATIVE : REACH_SURVIVAL; }

  /** Per-frame update. eye/dir describe the player's eye ray. */
  update(dt, ex, ey, ez, dx, dy, dz) {
    const held = this.heldItemId;
    const includeWater = held === ItemIds.BUCKET; // an empty bucket may target water sources
    this.raycaster.cast(ex, ey, ez, dx, dy, dz, this.reach, this.target, includeWater);
    this._eye.x = ex; this._eye.y = ey; this._eye.z = ez;
    const t = this.target;
    // Mobs along the eye ray: the closer hit wins (no selection box on mobs).
    const mobs = this.entities.mobs;
    const mobHit = mobs && !this.player.isSpectator ? mobs.raycast(ex, ey, ez, dx, dy, dz, ATTACK_REACH) : null;
    this.targetMob = mobHit && (!t.hit || mobHit.distance < t.distance) ? mobHit.mob : null;
    // Other players (Update #9 §8 PvP): the nearest of block / mob / player wins.
    const rpHit = this.remotePlayers && !this.player.isSpectator ? this.remotePlayers.raycast(ex, ey, ez, dx, dy, dz, ATTACK_REACH) : null;
    this.targetPlayer = rpHit && (!t.hit || rpHit.distance < t.distance) && (!mobHit || rpHit.distance < mobHit.distance) ? rpHit.player : null;
    if (this.targetPlayer) this.targetMob = null;
    if (this.targetMob || this.targetPlayer) this.selectionBox.hide(); else this.selectionBox.update(t);
    const key = t.hit ? `${t.blockPos.x},${t.blockPos.y},${t.blockPos.z}` : null;
    if (key !== this.lastTargetKey) { this.progress = 0; this.lastTargetKey = key; }

    if (!this.enabled || !this.input.pointerLocked || this.player.isSpectator) {
      this._stopMining();
      this.placeTimer = 0;
      this.eatTimer = 0;
      return;
    }

    this.creativeCooldown = Math.max(0, this.creativeCooldown - dt);
    this.attackLockTimer = Math.max(0, this.attackLockTimer - dt);
    const attack = this.actions.isActive('attack');
    const use = this.actions.isActive('use');
    if (!attack) this.attackLatched = false;

    if (this.targetPlayer) {
      this._stopMining();
      if (this.actions.wasPressed('attack')) this._attackPlayer(this.targetPlayer);
    } else if (this.targetMob) {
      // A ray that hits a mob only ever attacks; the block behind it is never touched.
      this._stopMining();
      if (this.actions.wasPressed('attack')) this._attackMob(this.targetMob);
    } else if (attack && t.hit && !this.attackLatched && this.attackLockTimer <= 0 && !(this.player.isCreative && isSword(held))) this._mine(dt); // swords never break blocks in Creative
    else this._stopMining();

    // Eating (Update #9 §8): hold use with food while below max health; 1.6 s with chewing sounds and crumbs.
    const food = held != null ? ItemRegistry.food(held) : null;
    if (food && use && this.canEat && this.canEat()) {
      if (this.eatTimer === 0) this.chewTimer = 0.15;
      this.eatTimer += dt;
      this.chewTimer -= dt;
      if (this.chewTimer <= 0) { this.chewTimer = 0.28; this.events.emit('player:eating', held, this.eatProgress); }
      if (this.eatTimer >= EAT_SECONDS) {
        this.eatTimer = 0;
        if (!this.player.isCreative) this.inventory.removeFromSlot(this.inventory.selectedIndex, 1);
        this.events.emit('player:ate', held, food.heal);
      }
      this.placeTimer = 0;
    } else {
      this.eatTimer = 0;
      if (use) {
        if (this.actions.wasPressed('use')) { this._place(false); this.placeTimer = 0; }
        else {
          this.placeTimer += dt;
          if (this.placeTimer >= PLACE_REPEAT_SECONDS) { this.placeTimer = 0; this._place(true); }
        }
      } else this.placeTimer = 0;
    }

    if (this.actions.wasPressed('pick') && t.hit) this._pickBlock(t.blockId);
  }

  /**
   * Hit a mob with the held item's damage; the mob is knocked away from the player. A hit while falling
   * (moving down, off the ground, not in water, not flying) is a critical hit for 1.5× damage.
   */
  _attackMob(mob) {
    const p = this.player;
    const crit = p.velocity.y < 0 && !p.onGround && !p.inWater && !p.flying;
    this.events.emit('player:swing');
    this.attackLockTimer = ATTACK_BLOCK_SECONDS;
    this.attackLatched = true; // holding the button through a kill must not start mining the block behind
    const damage = attackDamage(this.heldItemId) * (crit ? 1.5 : 1);
    if (this.guest) { this.events.emit('player:attack', mob.id, damage, crit); return; } // the host applies it and tells everyone
    this.entities.mobs.hit(mob, damage, p.position.x, p.position.z, crit);
  }

  /** Hit another player (multiplayer): the host validates and applies the damage; the swing shows at once. */
  _attackPlayer(rp) {
    const p = this.player;
    const crit = p.velocity.y < 0 && !p.onGround && !p.inWater && !p.flying;
    this.events.emit('player:swing');
    this.attackLockTimer = ATTACK_BLOCK_SECONDS;
    this.attackLatched = true;
    this.events.emit('player:hitPlayer', rp.id, crit);
  }

  /** Spawn egg (Creative catalog only): the mob appears on top of the clicked face. */
  _useSpawnEgg(type) {
    const def = MOB_BY_TYPE[type];
    const t = this.target;
    if (!def || !t.hit || !this.entities.mobs) return;
    const p = t.placePos;
    if (!this.world.isLoadedAt(p.x, p.z)) return;
    this.entities.mobs._add(def, p.x + 0.5, p.y, p.z + 0.5, (Math.random() * 4294967296) >>> 0, Math.random() * Math.PI * 2, def.health);
    this.events.emit('player:swing');
    this.audio.playUI('pop', 0.6);
  }

  _stopMining() {
    if (this.mining) { this.events.emit('player:swing:stop'); this.events.emit('mining:stop'); }
    this.mining = false;
    this.mineSendTimer = 0;
    this.progress = 0;
    this.breakOverlay.hide();
    this.hitSoundTimer = 0;
    this.swingTimer = 0;
  }

  _mine(dt) {
    const t = this.target;
    const id = t.blockId;
    if (!this.mining) { this.mining = true; this.events.emit('player:swing'); this.swingTimer = 0; }
    this.swingTimer += dt;
    if (this.swingTimer >= SWING_INTERVAL) { this.swingTimer = 0; this.events.emit('player:swing'); }

    if (this.player.isCreative) {
      if (this.creativeCooldown <= 0) { this.breakBlock(t.blockPos.x, t.blockPos.y, t.blockPos.z, true); this.creativeCooldown = CREATIVE_BREAK_COOLDOWN; }
      return;
    }
    const held = this.inventory.getSelected();
    const time = effectiveBreakTime(id, held ? held.itemId : null); // pickaxes speed up stone-type blocks
    if (!isFinite(time)) { this.breakOverlay.hide(); return; }
    if (time <= 0) { this.breakBlock(t.blockPos.x, t.blockPos.y, t.blockPos.z); return; }
    this.progress += dt / time;
    this.hitSoundTimer -= dt;
    if (this.hitSoundTimer <= 0) {
      this.hitSoundTimer = HIT_SOUND_INTERVAL;
      this.audio.playBlock('hit', id, t.blockPos.x + 0.5, t.blockPos.y + 0.5, t.blockPos.z + 0.5, 0.5);
    }
    if (this.progress >= 1) {
      this.breakBlock(t.blockPos.x, t.blockPos.y, t.blockPos.z);
      this.progress = 0;
    } else {
      this.breakOverlay.update(t.blockPos.x, t.blockPos.y, t.blockPos.z, this.progress);
      this.mineSendTimer -= dt;
      if (this.mineSendTimer <= 0) { this.mineSendTimer = 0.2; this.events.emit('mining:progress', t.blockPos.x, t.blockPos.y, t.blockPos.z, this.progress); }
    }
  }

  /**
   * Remove a block with effects and drops; cascades to unsupported blocks above.
   * @param {boolean} force Creative: also breaks unbreakable blocks (bedrock), dropping nothing.
   */
  breakBlock(x, y, z, force = false) {
    const id = this.world.getBlock(x, y, z);
    if (id === BlockIds.AIR || (!force && !isFinite(BREAK_TIME[id]))) return;
    this.world.setBlock(x, y, z, BlockIds.AIR);
    this.audio.playBlock('break', id, x + 0.5, y + 0.5, z + 0.5);
    this.particles.spawnBlockBreak(x, y, z, id, 12 + Math.floor(Math.random() * 8));
    this.breakOverlay.hide();
    if (!this.player.isCreative && !this.guest) { // on a LAN server the host spawns the drop for everyone
      const dropName = BlockRegistry.dropName(id);
      const drop = dropName ? ItemRegistry.idOf(dropName) : -1; // blocks or items (coal ore → coal)
      if (drop >= 0 && Math.random() < BlockRegistry.dropChance(id)) {
        this.entities.spawnItem(x + 0.5, y + 0.3, z + 0.5, drop, 1);
      }
    }
    // Plants and standing torches above, wall torches beside: whatever this block held up breaks too (Update #11).
    breakDependents(this.world, x, y, z, (nx, ny, nz) => this.breakBlock(nx, ny, nz));
    this.events.emit('block:broken', x, y, z, id);
  }

  /** Cardinal direction a placed block's front should face so it looks at the player. */
  _facingTowardPlayer() {
    const fx = Math.sin(this.player.yaw), fz = Math.cos(this.player.yaw); // opposite of the look direction
    if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 'east' : 'west';
    return fz > 0 ? 'south' : 'north';
  }

  /** Buckets: pick up a water source with an empty bucket, or pour a source out of a water bucket. */
  _useBucket(itemId) {
    const t = this.target;
    if (!t.hit) return;
    const creative = this.player.isCreative;
    if (itemId === ItemIds.BUCKET) {
      // Only sources can be picked up (flowing water / lava cannot); lava fills a Lava Bucket (Update #11).
      const filled = isSource(t.blockId) ? ItemIds.WATER_BUCKET : isLavaSource(t.blockId) ? ItemIds.LAVA_BUCKET : null;
      if (filled === null) return;
      const b = t.blockPos;
      this.world.setBlock(b.x, b.y, b.z, BlockIds.AIR);
      this.audio.playPlayer('bucket_fill', 0.8);
      this.events.emit('player:swing');
      if (!creative) {
        this.inventory.removeFromSlot(this.inventory.selectedIndex, 1);
        const left = this.inventory.addItem(filled, 1);
        if (left > 0) this.entities.spawnItem(this.player.position.x, this.player.position.y + 0.5, this.player.position.z, filled, 1);
      }
      return;
    }
    // Water / lava bucket: a source at the placement position (into a plant / flowing liquid is fine).
    let px = t.placePos.x, py = t.placePos.y, pz = t.placePos.z;
    const rt = RENDER_TYPE[t.blockId];
    if (rt === RenderType.CROSS || rt === RenderType.TORCH) { px = t.blockPos.x; py = t.blockPos.y; pz = t.blockPos.z; }
    const cur = this.world.getBlock(px, py, pz);
    if (!BlockRegistry.isReplaceable(cur) || !this.world.isLoadedAt(px, pz) || py < 0 || py > 255) return;
    this.world.setBlock(px, py, pz, itemId === ItemIds.LAVA_BUCKET ? BlockIds.LAVA : BlockIds.WATER);
    this.audio.playPlayer('bucket_empty', 0.8);
    this.events.emit('player:swing');
    if (!creative) this.inventory.set(this.inventory.selectedIndex, new ItemStack(ItemIds.BUCKET, 1));
  }

  /**
   * Right-click (the "use" action): open a station under the crosshair, else equip held armor (Update #8), use a
   * bucket or a spawn egg, or place the held block. `repeat` is true for the held-button auto-repeat, which
   * never equips armor (that would swap the piece back and forth).
   */
  _place(repeat = false) {
    const t = this.target;
    // Right-clicking a crafting table / furnace opens it, unless sneaking (then a block is placed against it).
    const station = t.hit ? BlockRegistry.stationOf(t.blockId) : null;
    if (station && !this.player.sneaking) { this.events.emit('station:open', station, t.blockPos); return; }
    const stack = this.inventory.getSelected();
    if (!stack) return;
    const armor = ItemRegistry.armor(stack.itemId);
    if (armor) { if (!repeat) this._equipArmor(armor); return; }
    if (!t.hit) return;
    if (stack.itemId === ItemIds.BUCKET || stack.itemId === ItemIds.WATER_BUCKET || stack.itemId === ItemIds.LAVA_BUCKET) { this._useBucket(stack.itemId); return; }
    const item = ItemRegistry.get(stack.itemId);
    if (item && item.spawnEgg) { this._useSpawnEgg(item.spawnEgg); return; }
    if (!item || !item.isBlock) return; // non-block items (coal, ingots, pickaxes) never place anything
    let id = item.blockId;
    if (BlockRegistry.hasFacing(id)) id = BlockRegistry.facingVariant(id, this._facingTowardPlayer());
    // Logs lie along the axis of the clicked face (top/bottom → vertical, east/west → X, north/south → Z).
    if (BlockRegistry.hasAxis(id)) { const n = t.faceNormal; id = BlockRegistry.axisVariant(id, n.x !== 0 ? 'x' : n.z !== 0 ? 'z' : 'y'); }
    const p = t.placePos;
    if (p.y < 0 || p.y > 255) return;
    // The targeted block itself may be replaceable (plants): place into it instead.
    let px = p.x, py = p.y, pz = p.z;
    const intoPlant = RENDER_TYPE[t.blockId] === RenderType.CROSS;
    if (intoPlant) { px = t.blockPos.x; py = t.blockPos.y; pz = t.blockPos.z; }
    const cur = this.world.getBlock(px, py, pz);
    if (!BlockRegistry.isReplaceable(cur)) return;
    if (!this.world.isLoadedAt(px, pz)) return;
    // Torches (Update #11): on top of a block they stand, on its side they hang on that wall (tilted), never under a
    // ceiling and never in a liquid; only full solid opaque cubes hold them (checked by isSupported below).
    if (BlockRegistry.isTorch(id)) {
      const n = t.faceNormal;
      if (isLiquid(cur)) return;
      if (!intoPlant) {
        if (n.y < 0) return; // ceiling: nothing happens, nothing is used
        if (n.y === 0) id = BlockRegistry.attachVariant(id, n.x > 0 ? 'west' : n.x < 0 ? 'east' : n.z > 0 ? 'north' : 'south');
      }
    }
    // Never inside anyone: the local player, other players or a mob (checked before the item is consumed; on a
    // LAN server the host runs the same check, so a rejection for this reason is rare and refunds the item).
    if (SOLID[id] === 1 && (this.player.aabb.intersectsBox(px, py, pz, px + 1, py + 1, pz + 1) || (this.entityBlocks && this.entityBlocks(px, py, pz)))) return;
    if (!isSupported(this.world, px, py, pz, id)) return;
    const slot = this.inventory.selectedIndex, consumedId = stack.itemId;
    this.world.setBlock(px, py, pz, id);
    this.audio.playBlock('place', id, px + 0.5, py + 0.5, pz + 0.5);
    this.events.emit('player:swing');
    let consumed = null;
    if (!this.player.isCreative) {
      this.inventory.removeFromSlot(slot, 1);
      consumed = { itemId: consumedId, slot };
    }
    this.events.emit('block:placed', px, py, pz, id, consumed);
  }

  /** Held armor → its armor slot (swapping with the worn piece), with a wooden clunk or a metal clink and a swing. */
  _equipArmor(armor) {
    const slot = this.inventory.equipFromSlot(this.inventory.selectedIndex);
    if (slot < 0) return;
    this.audio.playPlayer(armor.material === 'wood' ? 'equip_wood' : 'equip_metal', 0.8);
    this.events.emit('player:swing');
    this.events.emit('player:equip', armor);
  }

  _pickBlock(blockId) {
    const base = BlockRegistry.baseOf(blockId);
    if (!ItemRegistry.has(base)) return;
    const inv = this.inventory;
    const slot = inv.findInHotbar(base);
    if (slot >= 0) { inv.setSelectedIndex(slot); return; }
    if (this.player.isCreative) inv.set(inv.selectedIndex, new ItemStack(base, 1));
  }
}
