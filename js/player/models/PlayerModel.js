// PlayerModel.js — third-person body built from the six skin-textured boxes of the 64×64 Minecraft skin layout
// (SkinLayout.js, textures/entity/player.png: the face is painted into the head's front pixels, so there are no eye
// boxes): walk cycle, head look, body yaw lag, sneaking tilt, forward arm swing while mining/placing, a held item in the
// right hand (with the bow's draw frames and an aiming pose), worn armor as a textured 3D layer (ArmorModel.js), and a
// horizontal swimming pose with still arms and a flutter kick.

import * as THREE from 'three';
import { createSkinPart, PX, setToolHandleRotation, tintModelLight } from './ModelParts.js';
import { SKIN_PART_BY_NAME } from './SkinLayout.js';
import { createBlockGeometry } from '../../rendering/BlockGeometry.js';
import { BlockRegistry } from '../../blocks/BlockRegistry.js';
import { Direction } from '../../utils/Direction.js';
import { sameLight, copyLight } from '../../rendering/LightUniforms.js';
import { createItemSpriteGeometry } from '../../rendering/ItemSpriteGeometry.js';
import { ItemRegistry } from '../../items/ItemRegistry.js';
import { BOW_FRAMES } from '../../items/ItemDefinitions.js';
import { angleDelta, damp, clamp } from '../../utils/MathUtils.js';
import { WALK_SPEED, POSE_TRANSITION_SECONDS, PLAYER_SWIM_HEIGHT } from '../../config/Constants.js';
import { buildArmorLayer, applyWornArmor } from './ArmorModel.js';

const BODY_LAG_LIMIT = 50 * Math.PI / 180;
const HIP_HEIGHT = 12 * PX;

/** Freestyle flutter kick: legs alternate ±SWIM_KICK_AMP at SWIM_KICK_HZ, a little faster when moving faster. */
export const SWIM_KICK_AMP = 0.35;
export const SWIM_KICK_HZ = 2.5;
export function flutterKick(t, out = { left: 0, right: 0 }) {
  const k = Math.sin(t * Math.PI * 2) * SWIM_KICK_AMP;
  out.left = k; out.right = -k;
  return out;
}
const KICK = { left: 0, right: 0 };
const NO_KICK = Object.freeze({ left: 0, right: 0 });

const hurtCache = new WeakMap();
/** Red-tinted copy of a material (textured ones multiply the map by a pink tint). */
function hurtVariant(mat) {
  let v = hurtCache.get(mat);
  if (!v) { v = mat.clone(); if (v.color) v.color.setRGB(1, 0.32, 0.32); if (v.emissive) v.emissive.setRGB(0.35, 0, 0); hurtCache.set(mat, v); }
  return v;
}

export class PlayerModel {
  /**
   * @param {THREE.Material} blockMaterial material for the held block cube / item sprite
   * @param {import('../../rendering/TextureAtlas.js').TextureAtlas} [atlas] needed for item sprites
   * @param {Map<string, THREE.Texture>} [entityTextures] armor sheets ('armor/<material>_layer_N')
   */
  constructor(blockMaterial, atlas = null, entityTextures = null) {
    this.root = new THREE.Group();
    this.blockMaterial = blockMaterial;
    this.atlas = atlas;
    this.entityTextures = entityTextures;
    this.bodyYaw = 0;
    this.walkTime = 0;
    this.swingProgress = 1;
    this.heldBlockId = 0;
    /** 0 = upright, 1 = horizontal swimming / crawling pose (eased). */
    this.swimBlend = 0;
    /** Hurt flash: seconds left with every part tinted red. */
    this.flashTimer = 0;
    this._hurtOn = false;
    /** Bow: 0 = not drawing, 1–3 = the pulling frame shown (both arms raised in an aiming pose). */
    this.bowFrame = 0;
    this.heldFrameTexture = null;
    this._build();
  }

  /** The skin sheet (textures/entity/player.png) when the entity textures are loaded. */
  get skin() { return this.entityTextures ? this.entityTextures.get('player') || null : null; }

  flash(seconds = 0.35) { this.flashTimer = seconds; }

  /** Brightness factor of the sky light at the model; cheap when unchanged. */
  setLight(factor) {
    if (sameLight(factor, this._lightFactor)) return;
    this._lightFactor = copyLight(factor, this._lightFactor);
    tintModelLight(this, this.root, factor);
  }

  /** Swap every part to a red-tinted copy of its material (cached per material) or back. */
  _setHurt(on) {
    if (on === this._hurtOn) return;
    this._hurtOn = on;
    this.root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      if (on) { if (!o.userData.baseMaterial) o.userData.baseMaterial = o.material; o.material = hurtVariant(o.userData.baseMaterial); }
      else if (o.userData.baseMaterial) { o.material = o.userData.baseMaterial; o.userData.baseMaterial = null; }
    });
  }

  _build() {
    const skin = this.skin;
    const P = SKIN_PART_BY_NAME;
    // Everything hangs off the hips group so the whole body can rotate horizontal for swimming.
    this.hips = new THREE.Group();
    this.hips.position.set(0, HIP_HEIGHT, 0);
    // The six textured boxes of the skin layout (the pivots keep the layout's joints: legs at the hips, arms 1 px below the shoulder top).
    this.leftLeg = createSkinPart(P.leftLeg, skin);
    this.rightLeg = createSkinPart(P.rightLeg, skin);
    // The model faces -Z, so its right-hand side is +X.
    this.leftLeg.pivot.position.set(-2 * PX, 0, 0);
    this.rightLeg.pivot.position.set(2 * PX, 0, 0);
    // Body pivot at the hips; torso above it; head and arms attached to the torso top.
    this.bodyPivot = new THREE.Group();
    this.bodyPivot.position.set(0, 0, 0);
    this.body = createSkinPart(P.body, skin);
    this.bodyPivot.add(this.body.mesh);
    this.head = createSkinPart(P.head, skin);
    this.head.pivot.position.set(0, 12 * PX, 0);
    this.bodyPivot.add(this.head.pivot);
    // Arms: shoulder pivots at the torso top corners (the hands are the skin's lower arm rows).
    this.leftArm = createSkinPart(P.leftArm, skin);
    this.rightArm = createSkinPart(P.rightArm, skin);
    this.leftArm.pivot.position.set(-6 * PX, 11 * PX, 0);
    this.rightArm.pivot.position.set(6 * PX, 11 * PX, 0);
    /** Hand markers (empty objects at the fists) for poses and checks. */
    this.hands = [];
    for (const arm of [this.leftArm, this.rightArm]) {
      const hand = new THREE.Object3D();
      hand.position.set(0, -10 * PX, 0);
      arm.pivot.add(hand);
      arm.hand = hand;
      this.hands.push(hand);
    }
    this.bodyPivot.add(this.leftArm.pivot, this.rightArm.pivot);
    // Held block anchor at the right hand.
    this.heldAnchor = new THREE.Group();
    this.heldAnchor.position.set(0, -12 * PX, -3 * PX);
    this.heldAnchor.rotation.set(0.3, -0.6, 0);
    this.rightArm.pivot.add(this.heldAnchor);
    this.heldMesh = null;
    this.hips.add(this.leftLeg.pivot, this.rightLeg.pivot, this.bodyPivot);
    this.root.add(this.hips);
    this._buildArmor();
  }

  /** Armor layer: textured, inflated boxes on the same pivots as the body parts (ArmorParts.js), hidden until worn. */
  _buildArmor() {
    this.armorMeshes = buildArmorLayer({
      head: this.head.pivot, body: this.bodyPivot,
      leftArm: this.leftArm.pivot, rightArm: this.rightArm.pivot,
      leftLeg: this.leftLeg.pivot, rightLeg: this.rightLeg.pivot,
    });
    this.armor = { helmet: null, chestplate: null, gauntlets: null, leggings: null, boots: null };
  }

  /** Show worn armor: { helmet: 'wood' | 'iron' | 'diamond' | null, chestplate, gauntlets, leggings, boots }. */
  setArmor(worn) {
    let changed = false;
    for (const slot of Object.keys(this.armor)) {
      const material = worn && worn[slot] ? worn[slot] : null;
      if (this.armor[slot] !== material) { this.armor[slot] = material; changed = true; }
    }
    if (changed) applyWornArmor(this.armorMeshes, this.armor, this.entityTextures);
  }

  /**
   * Show an item in the right hand: block items as a cube, other items as an extruded sprite. `frameTexture` replaces the
   * item's own texture for the sprite (the bow's pulling frames).
   */
  setHeldItem(itemId, frameTexture = null) {
    if (itemId === this.heldBlockId && frameTexture === this.heldFrameTexture) return;
    this.heldBlockId = itemId;
    this.heldFrameTexture = frameTexture;
    if (this.heldMesh) { this.heldMesh.removeFromParent(); this.heldMesh = null; } // a tool's heldMesh is its pivot group; either way leave the actual parent
    const item = itemId ? ItemRegistry.get(itemId) : null;
    if (!item) return;
    if ((item.isBlock && !BlockRegistry.isTorch(item.blockId)) || !this.atlas) {
      this.heldMesh = new THREE.Mesh(createBlockGeometry(item.blockId ?? itemId, 0.38), this.blockMaterial);
      this.heldMesh.position.set(0, 0, 0);
      this.heldMesh.rotation.set(0, 0, 0);
    } else {
      const size = 0.6;
      this.heldMesh = new THREE.Mesh(createItemSpriteGeometry(this.atlas, frameTexture || (item.isBlock ? BlockRegistry.faceTexture(item.blockId, Direction.SOUTH) : item.texture), size), this.blockMaterial); // torches: their sprite
      if (item.tool) {
        // Tools pivot at the grip (the sprite's bottom-left corner sits on the hand): the mesh is offset by
        // half its size inside a handle group (45° roll stands the diagonal up, then the edge turn about the
        // handle so the point / blade leads) under a pivot whose pitch leans the head forward, so the arm
        // swing carries the head forward and down.
        const pivot = new THREE.Group();
        const handle = setToolHandleRotation(new THREE.Group());
        this.heldMesh.position.set(size / 2, size / 2, 0);
        handle.add(this.heldMesh);
        pivot.add(handle);
        pivot.rotation.set(-0.9, 0.15, 0, 'YXZ');
        pivot.userData.toolMesh = this.heldMesh;
        this.heldAnchor.add(pivot);
        this.heldMesh = pivot;
        return;
      }
      this.heldMesh.position.set(0, 0.16, 0);
      this.heldMesh.rotation.set(-0.2, 0, 0, 'ZYX');
      if (item.bow) { this.heldMesh.position.set(0.05, 0.22, -0.05); this.heldMesh.rotation.set(-0.35, 0.3, 0.9, 'ZYX'); } // the bow stands upright in the fist
    }
    this.heldAnchor.add(this.heldMesh);
  }

  /** The bow draw: frame 0 = not drawing (arms down), 1–3 = both arms raised forward in an aiming pose with that pulling frame on the bow. */
  setAiming(frame) {
    frame = frame | 0;
    if (frame === this.bowFrame) return;
    this.bowFrame = frame;
    const item = this.heldBlockId ? ItemRegistry.get(this.heldBlockId) : null;
    if (item && item.bow) this.setHeldItem(this.heldBlockId, frame > 0 ? BOW_FRAMES[Math.min(2, frame - 1)] : null);
  }

  /** @deprecated alias */
  setHeldBlock(blockId) { this.setHeldItem(blockId); }

  swing() { this.swingProgress = 0; }

  /**
   * @param {number} dt
   * @param {import('../Player.js').Player} player
   */
  update(dt, player) {
    if (this.flashTimer > 0) { this.flashTimer -= dt; this._setHurt(true); } else if (this._hurtOn) this._setHurt(false);
    const p = player;
    this.root.position.copy(p.renderPosition);
    // Body yaw lags behind the head.
    const moving = p.horizontalSpeed > 0.2;
    let delta = angleDelta(p.yaw, this.bodyYaw);
    if (Math.abs(delta) > BODY_LAG_LIMIT) this.bodyYaw = p.yaw - Math.sign(delta) * BODY_LAG_LIMIT;
    else if (moving) this.bodyYaw += delta * (1 - Math.exp(-10 * dt));
    delta = angleDelta(p.yaw, this.bodyYaw);
    this.root.rotation.y = this.bodyYaw;
    this.root.rotation.z = 0; // applyDeathPose() tips the body after this

    // Swimming / crawling: the body lies horizontal along the swim direction (eased over ~0.25 s).
    const lowPose = !!(p.swimming || p.crawling);
    this.swimBlend = damp(this.swimBlend, lowPose ? 1 : 0, 4 / POSE_TRANSITION_SECONDS, dt);
    const sw = this.swimBlend;
    const poseAngle = -(Math.PI / 2 - (p.swimming ? p.pitch : 0));
    this.hips.rotation.x = sw * poseAngle;
    this.hips.position.y = HIP_HEIGHT + (PLAYER_SWIM_HEIGHT / 2 - HIP_HEIGHT) * sw;
    // The head keeps looking along the look direction whatever the body does (the sneak lean is compensated below).
    this.head.pivot.rotation.set(p.pitch - this.hips.rotation.x, delta, 0, 'YXZ');

    // Walk cycle.
    const speedFactor = clamp(p.horizontalSpeed / WALK_SPEED, 0, 1.6) * (p.sprinting ? 1.15 : 1);
    if (p.horizontalSpeed > 0.1 && !p.flying) this.walkTime += dt * Math.max(0.6, speedFactor);
    const swingAmp = (p.flying || p.inWater) ? 0.15 : 0.8;
    const walkAngle = Math.sin(this.walkTime * 6.66) * swingAmp * (p.flying ? 1 : speedFactor);
    // Swim cycle: arms still along the sides, legs in an alternating flutter kick (opposite phase).
    const swimTime = p.swimTime || 0;
    const speedUp = 1 + clamp(Math.hypot(p.velocity ? p.velocity.x : 0, p.velocity ? p.velocity.z : 0) / 5.5, 0, 1) * 0.4;
    const kick = p.swimming ? flutterKick(swimTime * speedUp * SWIM_KICK_HZ, KICK) : NO_KICK; // reused
    this.leftLeg.pivot.rotation.x = walkAngle * (1 - sw) + kick.left * sw;
    this.rightLeg.pivot.rotation.x = -walkAngle * (1 - sw) + kick.right * sw;
    this.leftArm.pivot.rotation.x = -walkAngle * (1 - sw);
    let rightArm = walkAngle * (1 - sw);
    this.swimSpreadZ = 0;
    // Mining / placing swing on the right arm: positive x raises the arm forward (the model faces -Z).
    if (this.swingProgress < 1) {
      this.swingProgress = Math.min(1, this.swingProgress + dt / 0.3);
      const s = Math.sin(Math.sqrt(this.swingProgress) * Math.PI);
      rightArm += s * 1.6;
      this.rightArm.pivot.rotation.y = -s * 0.3;
    } else this.rightArm.pivot.rotation.y = 0;
    this.rightArm.pivot.rotation.x = rightArm;
    // A held item raises the arm slightly forward.
    if (this.heldMesh) this.rightArm.pivot.rotation.x += 0.35;
    // Drawing a bow: both arms point forward along the look direction, the left a little across the chest.
    if (this.bowFrame > 0 && sw < 0.5) {
      this.rightArm.pivot.rotation.x = Math.PI / 2 + p.pitch * 0.6;
      this.leftArm.pivot.rotation.x = Math.PI / 2 + p.pitch * 0.6;
      this.rightArm.pivot.rotation.y = 0.12; this.leftArm.pivot.rotation.y = -0.35;
    }

    // Sneak: the torso leans forward about 0.5 rad toward the look direction (the model faces -Z, so a
    // negative x rotation tips the chest forward), the head stays level.
    const tilt = p.sneaking ? -0.5 : 0;
    this.bodyPivot.rotation.x = damp(this.bodyPivot.rotation.x, tilt, 15, dt);
    this.head.pivot.rotation.x -= this.bodyPivot.rotation.x;
    this.bodyPivot.position.y = -(p.sneaking ? 3 : 0) * PX;
    this.bodyPivot.position.z = p.sneaking ? 2.5 * PX : 0;
    this.leftLeg.pivot.position.z = this.rightLeg.pivot.position.z = p.sneaking ? 2 * PX : 0;
    // Idle arm sway (while swimming the arms rest along the sides). Positive z on a hanging arm moves the
    // hand toward +X, so the left arm (at -X) takes the negative value to sway outward.
    const spread = 0.03 + Math.sin(this.walkTime * 0.5) * 0.02 + (this.swimSpreadZ || 0);
    this.leftArm.pivot.rotation.z = -spread;
    this.rightArm.pivot.rotation.z = spread;
  }

  /**
   * Pose the model as a swimmer at kick phase `phase` ∈ [0, 1) with no smoothing (used by the headless
   * swimming check): horizontal body, arms still along the sides, flutter-kick legs in opposite phase,
   * head looking along the swim direction. World matrices are updated before returning.
   */
  /** Dead (like a mob): the body tips over sideways with a smoothstep over t 0..1, lifted so it pivots on its side. Call after update(). */
  applyDeathPose(t) {
    const k = Math.min(1, Math.max(0, t)), e = k * k * (3 - 2 * k);
    this.root.rotation.z = e * Math.PI / 2;
    this.root.position.y += e * 0.3;
  }

  setSwimPose(phase, pitch = 0) {
    this.swimBlend = 1;
    this.root.rotation.y = 0;
    this.hips.rotation.x = -(Math.PI / 2 - pitch);
    this.hips.position.y = PLAYER_SWIM_HEIGHT / 2;
    this.head.pivot.rotation.set(pitch - this.hips.rotation.x, 0, 0, 'YXZ');
    this.bodyPivot.rotation.x = 0;
    this.bodyPivot.position.set(0, 0, 0);
    const kick = flutterKick(((phase % 1) + 1) % 1, KICK);
    this.leftLeg.pivot.rotation.set(kick.left, 0, 0);
    this.rightLeg.pivot.rotation.set(kick.right, 0, 0);
    this.leftLeg.pivot.position.z = this.rightLeg.pivot.position.z = 0;
    this.swimSpreadZ = 0;
    this.leftArm.pivot.rotation.set(0, 0, -0.03);
    this.rightArm.pivot.rotation.set(0, 0, 0.03);
    this.root.updateMatrixWorld(true);
    return kick;
  }
}
