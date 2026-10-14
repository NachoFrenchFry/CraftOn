// HealthSystem.js — the player's health: regeneration, fall damage with armor, hurt feedback
// (sound, red model flash, camera tilt, HUD flash, knockback), eating, death (drops or keep inventory, the
// "You died!" screen) and respawn. Damage only happens in Survival; Creative and Spectator never take any.
// Multiplayer: the host validates player-vs-player hits and tells the victim the amount (GuestClient /
// HostServer); each player computes its own fall damage and reports its health to the host.
import { State } from '../core/GameState.js';
import { MAX_HEALTH, REGEN_SECONDS, INVULNERABLE_SECONDS, RESPAWN_INVULNERABLE_SECONDS, LAVA_DAMAGE_INTERVAL, FIRE_SECONDS, FIRE_INTERVAL, fallDamage, lavaDamage, fireDamage, causeText } from './Damage.js';
import { ITEM_THROW_PICKUP_DELAY, PLAYER_DEATH_SECONDS } from '../config/Constants.js';

/** A guest waits this long for the host's SPAWN_AT before respawning on its own (the link is probably gone by then). */
const RESPAWN_FALLBACK_MS = 5000;
import { INVENTORY_SIZE, TOTAL_SLOTS } from '../items/Inventory.js';

export class HealthSystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.regenTimer = 0;
    this.invulnTimer = 0;
    /** Seconds left of the HUD / model hurt flash. */
    this.hurtFlash = 0;
    /** Health before the last damage (the HUD's white "recent damage" chip shrinks from it). */
    this.chipFrom = MAX_HEALTH;
    this.deathCause = null;
    this.deathPosition = null;
    /** Seconds since the death (the body tips over, then puffs); -1 while alive. */
    this.deathTimer = -1;
    this.puffed = false;
    /** A guest's respawn is pending until the host answers with SPAWN_AT. */
    this.respawnPending = false;
    this._respawnFallback = null;
    /** Lava: time to the next lava tick; the fire tick while burning. */
    this.lavaTimer = 0;
    this.fireTick = 0;
  }

  get player() { return this.game.player; }
  /** Health matters only in Survival (the bar hides and nothing hurts in Creative / Spectator). */
  get active() { const p = this.game.player; return !p.isCreative && !p.isSpectator; }
  get keepInventory() { const m = this.game.worldMeta; return !!(m && m.keepInventory); }
  canEat() { const p = this.player; return this.active && !p.dead && p.health < p.maxHealth; }

  /** A world starts: nothing lingering from the previous one. */
  reset() {
    this.regenTimer = 0; this.invulnTimer = 0; this.hurtFlash = 0;
    this.chipFrom = this.player.health;
    this.deathCause = null; this.deathPosition = null;
    this.deathTimer = -1; this.puffed = false; this.respawnPending = false;
    if (this._respawnFallback) { clearTimeout(this._respawnFallback); this._respawnFallback = null; }
    this.lavaTimer = 0; this.fireTick = 0; this.player.fireTimer = 0; this.player.onFire = false;
  }

  update(dt) {
    const g = this.game, p = g.player;
    if (!g.state.inWorld) return;
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.hurtFlash > 0) this.hurtFlash -= dt;
    if (p.dead) {
      p.fireTimer = 0; p.onFire = false;
      this.deathTimer += dt;
      // The body has tipped over: a puff of smoke, then it stays hidden until the respawn (other players see the same).
      if (!this.puffed && this.deathTimer >= PLAYER_DEATH_SECONDS) { this.puffed = true; g.particles.spawnPuff(p.position.x, p.position.y + 0.9, p.position.z, 12); }
      return;
    }
    this._lavaAndFire(dt);
    if (this.active && p.health < p.maxHealth) {
      this.regenTimer += dt;
      if (this.regenTimer >= REGEN_SECONDS) { this.regenTimer -= REGEN_SECONDS; this.heal(1); }
    } else this.regenTimer = 0;
  }

  /**
   * Lava: about 20 damage every 0.5 s while in it (armor reduces it), then on fire for 5 s at 5 per
   * second; water puts the fire out at once. Creative and Spectator never burn.
   */
  _lavaAndFire(dt) {
    const g = this.game, p = g.player, inv = g.inventory;
    if (!this.active) { p.fireTimer = 0; p.onFire = false; this.lavaTimer = 0; this.fireTick = 0; return; }
    if (p.inLava) {
      p.fireTimer = FIRE_SECONDS;
      this.lavaTimer -= dt;
      if (this.lavaTimer <= 0) { this.lavaTimer = LAVA_DAMAGE_INTERVAL; this.damage(lavaDamage(inv.armorPoints()), { kind: 'lava' }, { ignoreInvuln: true }); }
    } else this.lavaTimer = 0;
    if (p.inWater) p.fireTimer = 0;
    if (p.fireTimer > 0 && !p.dead) {
      p.fireTimer -= dt;
      if (!p.inLava) {
        this.fireTick -= dt;
        if (this.fireTick <= 0) { this.fireTick = FIRE_INTERVAL; this.damage(fireDamage(inv.armorPoints()), { kind: 'fire' }, { ignoreInvuln: true }); }
      }
    } else this.fireTick = 0;
    p.onFire = p.fireTimer > 0;
  }

  heal(n) {
    const p = this.player;
    if (p.dead || n <= 0) return;
    const before = p.health;
    p.health = Math.min(p.maxHealth, p.health + n);
    if (p.health !== before) { this.chipFrom = p.health; this.game.events.emit('player:health', p.health, before); }
  }

  /**
   * Take damage. `cause` is { kind: 'fall' | 'void' | 'pvp', by }. Options: kx / kz knockback direction (unit),
   * crit (bigger particles), ignoreInvuln (the host already validated the hit). Returns the damage applied.
   */
  damage(amount, cause, opts = {}) {
    const g = this.game, p = g.player;
    amount = Math.round(amount);
    if (!this.active || p.dead || amount <= 0) return 0;
    if (this.invulnTimer > 0 && !opts.ignoreInvuln) return 0;
    this.chipFrom = p.health;
    const before = p.health;
    p.health = Math.max(0, p.health - amount);
    this.invulnTimer = INVULNERABLE_SECONDS;
    this.hurtFlash = 0.35;
    this.regenTimer = 0;
    // Feedback: sound, camera tilt, the model flashes red (third person / other players see it), knockback.
    g.audio.playPlayer(p.health > 0 ? 'hurt' : 'death', 0.9);
    g.cameraController.hurt(opts.kx || 0, opts.kz || 0);
    g.playerModel.flash(0.35);
    if (opts.kx || opts.kz) { p.velocity.x += opts.kx * 6; p.velocity.z += opts.kz * 6; p.velocity.y = Math.max(p.velocity.y, 4); }
    if (opts.crit) g.particles.spawnCrit(p.position.x, p.position.y + 1.2, p.position.z, 24, 0.45, 1.6);
    g.events.emit('player:damaged', amount, cause, p.health, before);
    g.events.emit('player:health', p.health, before);
    if (p.health <= 0) this.die(cause);
    return amount;
  }

  /** Landing after a fall (PlayerPhysics 'player:land'): gentle damage, armor reduces it, boots count double. */
  onLand(fall) {
    const p = this.player, inv = this.game.inventory;
    if (!this.active || p.dead || p.inWater || p.inLava) return;
    const dmg = fallDamage(fall, inv.armorPoints(), inv.armorPointsFor('boots'));
    if (dmg > 0) this.damage(dmg, { kind: 'fall' }, { ignoreInvuln: true });
  }

  /** Below the void level: Survival dies, the other modes are put back at the spawn as before. */
  onVoid() {
    const g = this.game, p = g.player;
    if (this.active && !p.dead) { this.damage(p.maxHealth + 1000, { kind: 'void' }, { ignoreInvuln: true }); return; }
    p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
    g.events.emit('player:respawn'); // a guest also tells the host, which moves its baseline to the spawn
  }

  die(cause) {
    const g = this.game, p = g.player;
    if (p.dead) return;
    p.dead = true;
    p.health = 0;
    p.fireTimer = 0; p.onFire = false;
    this.deathCause = cause || { kind: 'other' };
    this.deathPosition = p.position.clone();
    this.deathTimer = 0; this.puffed = false;
    p.velocity.set(0, 0, 0);
    if (!this.keepInventory) this.dropInventory();
    g.interaction._stopMining();
    g.lock.release('death');
    g.state.set(State.DEAD);
    g.events.emit('player:died', this.deathCause);
  }

  /** Every stack (armor too) becomes an item entity where the player died; guests ask the host to spawn them. */
  dropInventory() {
    const g = this.game, inv = g.inventory, p = g.player;
    const x = p.position.x, y = p.position.y + 0.8, z = p.position.z;
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const s = inv.slots[i];
      if (!s) continue;
      const a = Math.random() * Math.PI * 2, speed = 1.5 + Math.random() * 2;
      const vx = Math.cos(a) * speed, vz = Math.sin(a) * speed, vy = 3 + Math.random() * 2;
      if (g.entities.throwHook) g.entities.throwHook(s.itemId, s.count, x, y, z, vx, vy, vz);
      else g.entities.spawnItem(x, y, z, s.itemId, s.count, vx, vy, vz, ITEM_THROW_PICKUP_DELAY);
      inv.slots[i] = null;
    }
    inv.changed();
    void INVENTORY_SIZE;
  }

  /**
   * Respawn button. Single player and the host respawn at their spawn point at once. A guest asks the host (RESPAWN):
   * the host picks the position, resets its movement baseline for us and answers with SPAWN_AT, so the body never stays
   * at the death spot for everyone else; if no answer comes within a few seconds we respawn on our own.
   */
  respawn() {
    const g = this.game, p = g.player;
    if (!p.dead || this.respawnPending) return;
    if (g.isGuest && g.net && g.net.requestRespawn) {
      this.respawnPending = true;
      g.net.requestRespawn('respawn');
      this._respawnFallback = setTimeout(() => { this._respawnFallback = null; if (this.respawnPending) this.respawnAt(p.spawn.x, p.spawn.y, p.spawn.z); }, RESPAWN_FALLBACK_MS);
      return;
    }
    this.respawnAt(p.spawn.x, p.spawn.y, p.spawn.z);
  }

  /** The host placed us: a respawn (full reset), a correction (snap back to the last position it accepted) or a void / teleport jump. */
  placeAt(x, y, z, reason) {
    const p = this.game.player;
    if (reason === 'respawn') { if (p.dead) this.respawnAt(x, y, z); else p.teleport(x, y, z); return; }
    if (reason === 'correction') console.info(`CraftOn net: the host corrected our position to ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`);
    p.teleport(x, y, z);
  }

  /** Alive again at (x, y, z) with full health and a short grace period. */
  respawnAt(x, y, z) {
    const g = this.game, p = g.player;
    if (!p.dead) return;
    this.respawnPending = false;
    if (this._respawnFallback) { clearTimeout(this._respawnFallback); this._respawnFallback = null; }
    this.deathTimer = -1; this.puffed = false;
    p.dead = false;
    p.health = p.maxHealth;
    this.chipFrom = p.health;
    this.invulnTimer = RESPAWN_INVULNERABLE_SECONDS;
    this.regenTimer = 0;
    this.lavaTimer = 0; this.fireTick = 0; p.fireTimer = 0; p.onFire = false;
    p.teleport(x, y, z);
    p.flying = false;
    g.session.settleAfterRespawn();
    g.state.set(State.PLAYING);
    g.requestPointerLock('respawn');
    g.events.emit('player:health', p.health, 0);
    g.events.emit('player:respawned');
  }

  get deathText() { return causeText(this.deathCause); }
}
