// HealthSystem.js — the player's health (Update #9 §8): regeneration, fall damage with armor, hurt feedback
// (sound, red model flash, camera tilt, HUD flash, knockback), eating, death (drops or keep inventory, the
// "You died!" screen) and respawn. Damage only happens in Survival; Creative and Spectator never take any.
// Multiplayer: the host validates player-vs-player hits and tells the victim the amount (GuestClient /
// HostServer); each player computes its own fall damage and reports its health to the host.
import { State } from '../core/GameState.js';
import { MAX_HEALTH, REGEN_SECONDS, INVULNERABLE_SECONDS, RESPAWN_INVULNERABLE_SECONDS, LAVA_DAMAGE_INTERVAL, FIRE_SECONDS, FIRE_INTERVAL, fallDamage, lavaDamage, fireDamage, causeText } from './Damage.js';
import { ITEM_THROW_PICKUP_DELAY } from '../config/Constants.js';
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
    /** Lava (Update #11): time to the next lava tick; the fire tick while burning. */
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
    this.lavaTimer = 0; this.fireTick = 0; this.player.fireTimer = 0; this.player.onFire = false;
  }

  update(dt) {
    const g = this.game, p = g.player;
    if (!g.state.inWorld) return;
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.hurtFlash > 0) this.hurtFlash -= dt;
    if (p.dead) { p.fireTimer = 0; p.onFire = false; return; }
    this._lavaAndFire(dt);
    if (this.active && p.health < p.maxHealth) {
      this.regenTimer += dt;
      if (this.regenTimer >= REGEN_SECONDS) { this.regenTimer -= REGEN_SECONDS; this.heal(1); }
    } else this.regenTimer = 0;
  }

  /**
   * Lava (Update #11): about 20 damage every 0.5 s while in it (armor reduces it), then on fire for 5 s at 5 per
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
    g.events.emit('player:respawn');
  }

  die(cause) {
    const g = this.game, p = g.player;
    if (p.dead) return;
    p.dead = true;
    p.health = 0;
    p.fireTimer = 0; p.onFire = false;
    this.deathCause = cause || { kind: 'other' };
    this.deathPosition = p.position.clone();
    p.velocity.set(0, 0, 0);
    if (!this.keepInventory) this.dropInventory();
    g.interaction._stopMining();
    g.input.exitPointerLock();
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

  /** Respawn button: back at the world spawn with full health and a short grace period. */
  respawn() {
    const g = this.game, p = g.player;
    if (!p.dead) return;
    p.dead = false;
    p.health = p.maxHealth;
    this.chipFrom = p.health;
    this.invulnTimer = RESPAWN_INVULNERABLE_SECONDS;
    this.regenTimer = 0;
    this.lavaTimer = 0; this.fireTick = 0; p.fireTimer = 0; p.onFire = false;
    p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
    p.flying = false;
    g.session.settleAfterRespawn();
    g.state.set(State.PLAYING);
    g.requestPointerLock();
    g.events.emit('player:health', p.health, 0);
    g.events.emit('player:respawned');
  }

  get deathText() { return causeText(this.deathCause); }
}
