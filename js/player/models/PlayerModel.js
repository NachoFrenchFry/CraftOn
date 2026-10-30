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
export const SWIM_KICK_HZ = 1.4;
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
    /** 0..1 blend of the bow-aiming arm pose (eased, so a shot just lowers the arms — no swing). */
    this.aimBlend = 0;
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
    // The swing of whatever is held: a relative rotation at the grip (the top leads forward and down), on top of the arm's.
    this.heldSwing = new THREE.Group();
    this.heldAnchor.add(this.heldSwing);
    // The bow hangs off an unrotated anchor at the same hand, so its pose can be reasoned about in the arm's own frame.
    this.bowAnchor = new THREE.Group();
    this.bowAnchor.position.set(0, -12 * PX, -3 * PX);
    this.rightArm.pivot.add(this.bowAnchor);
    this.heldMesh = null;
    // The glider wing: a textured delta above the back (the body's +Z side), shown while gliding; the arms reach up to it.
    this.wing = this._buildWing();
    this.wing.visible = false;
    this.bodyPivot.add(this.wing);
    this.hips.add(this.leftLeg.pivot, this.rightLeg.pivot, this.bodyPivot);
    this.root.add(this.hips);
    this._buildArmor();
  }

  /** A simple hang-glider: a delta of two triangles over textures/entity/glider.png (rows 0–15 the top, 16–31 the underside). */
  _buildWing() {
    const g = new THREE.BufferGeometry();
    // Body space: the apex over the head (+Y), the tips behind the hips (−Y) and out to the sides (±X), lying flat over the back.
    const pos = [0, 1.15, 0, -1.05, -0.55, 0, 0, -0.3, 0, 1.05, -0.55, 0];
    const uv = [0.5, 1, 0, 0.5, 0.5, 0.56, 1, 0.5];
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    const tex = this.entityTextures ? this.entityTextures.get('glider') || null : null;
    const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, alphaTest: 0.5 });
    if (!tex) mat.color.set(0xff00ff);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'wing';
    mesh.userData.noShadow = true;
    const group = new THREE.Group();
    group.add(mesh);
    group.position.set(0, 9 * PX, 7 * PX); // above the shoulders, behind the back
    group.rotation.set(0.15, 0, 0);
    return group;
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
        this.heldSwing.add(pivot);
        this.heldMesh = pivot;
        return;
      }
      this.heldMesh.position.set(0, 0.16, 0);
      this.heldMesh.rotation.set(-0.2, 0, 0, 'ZYX');
      if (item.bow) {
        // The bow stands upright in the fist (roll 45°: the sprite's diagonal stave up) with the wooden curve forward (−Z)
        // and the string toward the body, turned −57° about the stave so the face stays visible; the small −0.15 pitch
        // offsets part of the hanging arm's held-item lift. Aiming (the arm raised forward, rotated +90° about X): the arm's −Z is up and
        // −Y is forward, so a −90° pitch after the yaw stands it up again. Lives on the unrotated bow anchor.
        this.heldMesh.position.set(0, 0.08, 0);
        // Straight up, no lean: the −43° turn about the stave points the curve forward with the face toward the front.
        if (this.bowFrame > 0) this.heldMesh.rotation.set(-Math.PI / 2, -0.75, Math.PI / 4, 'XYZ');
        else this.heldMesh.rotation.set(-0.15, -0.75, Math.PI / 4, 'XYZ');
        this.bowAnchor.rotation.set(0, 0, 0);
        this.bowAnchor.add(this.heldMesh);
        return;
      }
    }
    this.heldSwing.add(this.heldMesh);
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

    // Swimming / crawling: the body lies horizontal along the swim direction (eased over ~0.25 s). Gliding: the same
    // prone pose along the flight direction (Minecraft's elytra pose), the wing shown above the back, both arms up to it.
    const gliding = !!p.gliding;
    const lowPose = !!(p.swimming || p.crawling) || gliding;
    this.swimBlend = damp(this.swimBlend, lowPose ? 1 : 0, 4 / POSE_TRANSITION_SECONDS, dt);
    this.glideBlend = damp(this.glideBlend || 0, gliding ? 1 : 0, 4 / POSE_TRANSITION_SECONDS, dt);
    const sw = this.swimBlend;
    const vel = p.velocity || null;
    const glidePitch = gliding && vel ? Math.atan2(vel.y, Math.hypot(vel.x, vel.z) || 1e-6) : 0;
    const poseAngle = -(Math.PI / 2 - (p.swimming ? p.pitch : gliding ? clamp(glidePitch, -1.2, 0.6) : 0));
    this.hips.rotation.x = sw * poseAngle;
    this.hips.position.y = HIP_HEIGHT + (PLAYER_SWIM_HEIGHT / 2 - HIP_HEIGHT) * sw + (gliding ? 0.5 : 0) * this.glideBlend;
    this.wing.visible = this.glideBlend > 0.05;
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
    // Minecraft's attack animation (HumanoidModel.setupAttackAnimation) on the right arm, carrying the held item: the body
    // twists by sin(√s·2π)·0.2, the arms follow the twist, the right arm raises forward by sin(f·π)·1.2 (f = 1 − (1 − s)⁴)
    // plus a term from the look pitch, and rolls inward by sin(s·π)·0.4. Positive x raises an arm forward here.
    let twist = 0, armRoll = 0;
    if (this.swingProgress < 1) {
      this.swingProgress = Math.min(1, this.swingProgress + dt / 0.3);
      const s = this.swingProgress;
      twist = Math.sin(Math.sqrt(s) * 2 * Math.PI) * 0.2;
      let f = 1 - s; f *= f; f *= f; f = 1 - f;
      const f1 = Math.sin(f * Math.PI), f2 = Math.sin(s * Math.PI) * (p.pitch + 0.7) * 0.75;
      rightArm += f1 * 1.2 + f2;
      this.leftArm.pivot.rotation.x += twist;
      armRoll = -Math.sin(s * Math.PI) * 0.4;
    }
    this.bodyPivot.rotation.y = twist;
    this.head.pivot.rotation.y -= twist; // the head keeps its own yaw while the body twists under it
    this.rightArm.pivot.rotation.y = twist * 2;
    this.leftArm.pivot.rotation.y = twist;
    this.heldSwing.rotation.set(0, 0, 0); // the held item simply follows the arm, as in Minecraft
    this.rightArm.pivot.rotation.x = rightArm;
    // A held item raises the arm slightly forward.
    if (this.heldMesh) this.rightArm.pivot.rotation.x += 0.35;
    // Drawing a bow: both arms point forward along the look direction, the left a little across the chest. The pose blends
    // in over a few frames and, after the shot, the arms simply lower again (no swing — for remote players too).
    const aiming = this.bowFrame > 0 && sw < 0.5;
    this.aimBlend = damp(this.aimBlend, aiming ? 1 : 0, aiming ? 24 : 12, dt); // quick to raise, a gentle lowering after the shot
    if (this.aimBlend > 0.01) {
      const ab = this.aimBlend, aim = Math.PI / 2 + p.pitch * 0.6;
      this.rightArm.pivot.rotation.x += (aim - this.rightArm.pivot.rotation.x) * ab;
      this.leftArm.pivot.rotation.x += (aim - this.leftArm.pivot.rotation.x) * ab;
      this.rightArm.pivot.rotation.y += (0.12 - this.rightArm.pivot.rotation.y) * ab;
      this.leftArm.pivot.rotation.y += (-0.35 - this.leftArm.pivot.rotation.y) * ab;
    }
    // Gliding: both arms reach up to the wing's bar (toward the body's +Z, which is up once the body lies prone).
    if (this.glideBlend > 0.01) {
      const gb = this.glideBlend;
      this.rightArm.pivot.rotation.x = this.rightArm.pivot.rotation.x * (1 - gb) + (-Math.PI / 2 + 0.25) * gb;
      this.leftArm.pivot.rotation.x = this.leftArm.pivot.rotation.x * (1 - gb) + (-Math.PI / 2 + 0.25) * gb;
      this.leftLeg.pivot.rotation.x *= 1 - gb; this.rightLeg.pivot.rotation.x *= 1 - gb;
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
    const spread = 0.03 + Math.sin(this.walkTime * 0.5) * 0.02 + (this.swimSpreadZ || 0) + (this.glideBlend || 0) * 0.45;
    this.leftArm.pivot.rotation.z = -spread;
    this.rightArm.pivot.rotation.z = spread + armRoll;
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
