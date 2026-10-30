// FirstPersonHand.js — the first-person arm and held block rendered in an overlay scene: forward swing
// (toward the crosshair), equip dip, view bobbing, look sway that trails the turn, idle breathing, and the
// worn chestplate sleeve / gauntlet as real inflated, textured boxes on the arm. Tools are
// gripped at the bottom of the handle and swing around that grip, so the head arcs forward and down onto
// the crosshair.

import * as THREE from 'three';
import { createSkinPart, createModelLights, setToolHandleRotation, tintModelLight, PX } from './ModelParts.js';
import { SKIN_PART_BY_NAME } from './SkinLayout.js';
import { BOW_FRAMES } from '../../items/ItemDefinitions.js';
import { buildFirstPersonArmor, applyWornArmor } from './ArmorModel.js';
import { createBlockGeometry } from '../../rendering/BlockGeometry.js';
import { BlockRegistry } from '../../blocks/BlockRegistry.js';
import { Direction } from '../../utils/Direction.js';
import { sameLight, copyLight } from '../../rendering/LightUniforms.js';
import { createItemSpriteGeometry } from '../../rendering/ItemSpriteGeometry.js';
import { ItemRegistry } from '../../items/ItemRegistry.js';
import { HAND_BOB } from '../../config/Constants.js';
import { damp } from '../../utils/MathUtils.js';

const SWING_TIME = 0.3; // 6 game ticks, like Minecraft (held items and blocks)
const FIST_SWING_TIME = 0.25; // the empty hand keeps its old, quicker punch
const BOW_KICK_TIME = 0.15; // the bow's recoil after a shot
const DEG = Math.PI / 180;
/** Minecraft's first-person hand: i = +1 for the right hand. */
const HAND = 1;
const EQUIP_TIME = 0.15;

export class FirstPersonHand {
  /**
   * @param {THREE.Scene} handScene
   * @param {THREE.Material} blockMaterial
   * @param {import('../../rendering/TextureAtlas.js').TextureAtlas} atlas for item sprites
   * @param {Map<string, THREE.Texture>} [entityTextures] armor sheets for the sleeve / gauntlet boxes
   */
  constructor(handScene, blockMaterial, atlas, entityTextures = null) {
    this.scene = handScene;
    this.blockMaterial = blockMaterial;
    this.atlas = atlas;
    this.entityTextures = entityTextures;
    this.heldIsTool = false;
    this.root = new THREE.Group();
    handScene.add(this.root);
    this.lights = createModelLights(); // [hemi, dir]; the shader pipeline turns the dir light toward the sun
    for (const l of this.lights) handScene.add(l);

    // Arm: the skin's right arm (4×12×4 px, textures/entity/player.png) whose local +Y runs from the shoulder (below the
    // screen) to the fist: the skin box hangs down from its pivot, so it is turned 180° about X like the armor boxes.
    // It gets a fixed Minecraft-like base transform: bottom right, pointing forward into the screen and slightly up
    // toward the center, only ~20° from vertical.
    this.armGroup = new THREE.Group();
    const arm = createSkinPart(SKIN_PART_BY_NAME.rightArm, entityTextures ? entityTextures.get('player') || null : null);
    arm.mesh.position.set(0, 6 * PX, 0); // the box centre 6 px up the local +Y (the fist ends at 12 px)
    arm.mesh.rotation.x = Math.PI;
    this.armMesh = arm.mesh;
    /** Aliases kept for callers and checks that knew the two flat-colour boxes. */
    this.sleeveMesh = arm.mesh;
    this.handMesh = arm.mesh;
    this.armGroup.add(arm.mesh);
    // Worn chestplate sleeve and gauntlet: textured boxes over the sleeve and the fist (hidden until worn).
    this.armorMeshes = buildFirstPersonArmor(this.armGroup);
    this.armor = { helmet: null, chestplate: null, gauntlets: null, leggings: null, boots: null };
    this.armGroup.scale.setScalar(1.35);
    this.root.add(this.armGroup);

    // Minecraft's item swing (ItemInHandRenderer): the sweep translation and the attack rotations go on handSwing, placed at
    // the item's rest offset; blockGroup inside it carries only each type's rest rotation (and the pivots).
    this.handSwing = new THREE.Group();
    this.root.add(this.handSwing);
    this.blockGroup = new THREE.Group();
    this.handSwing.add(this.blockGroup);
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._axisX = new THREE.Vector3(1, 0, 0); this._axisY = new THREE.Vector3(0, 1, 0); this._axisZ = new THREE.Vector3(0, 0, 1);
    // Tools sit inside a pivot placed at the grip (the sprite's bottom-left corner): the mesh is offset by
    // half its size so rotating the pivot swings the head around the wrist. Inside the pivot a handle group
    // rolls the sprite 45° (handle up) and turns it 90° about the handle so the point / edge leads the
    // swing. Two markers give the grip and head positions to the headless check.
    this.toolPivot = new THREE.Group();
    this.blockGroup.add(this.toolPivot);
    this.toolHandle = setToolHandleRotation(new THREE.Group());
    this.toolPivot.add(this.toolHandle);
    // Blocks, torches and flat items keep their own resting poses (the group) and swing on this pivot at their grip (the
    // bottom of what is held): the swing is a relative rotation layered on top of the pose, the top leading forward and down.
    this.swingPivot = new THREE.Group();
    this.blockGroup.add(this.swingPivot);
    this.toolGrip = new THREE.Object3D();
    this.toolHead = new THREE.Object3D();
    this.toolHandle.add(this.toolGrip, this.toolHead);
    this.blockMesh = null;
    this.heldBlockId = -1;

    this.swingProgress = 1;
    /** Eating progress 0..1: the food bobs toward the mouth. */
    this.eating = 0;
    /** Bow draw progress 0..1 (set by Game from the interaction): the bow turns upright toward the centre and the arm pulls back. */
    this.drawProgress = 0;
    /** Seconds since the last shot (a quick back-and-down kick of the bow while < BOW_KICK_TIME). */
    this.kick = BOW_KICK_TIME;
    this.heldFrameTexture = null;
    this.equipProgress = 1;
    this.pendingBlockId = 0;
    this.swayX = 0;
    this.swayY = 0;
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.time = 0;
    this.visible = true;
    this.setHeldBlock(0);
  }

  /** Change the shown item (block cube or extruded item sprite), with an equip dip if different. */
  setHeldItem(itemId) {
    // Compare with the item the hand is heading for, not the one still shown mid-dip, so quick
    // slot changes during the equip animation never leave a stale item in the hand.
    const target = this.equipProgress < 1 ? this.pendingBlockId : this.heldBlockId;
    if (itemId === target) return;
    if (this.heldBlockId === -1) { this._applyBlock(itemId); this.pendingBlockId = itemId; return; }
    this.pendingBlockId = itemId;
    if (this.equipProgress >= 1) this.equipProgress = 0; // start a dip; the swap happens at the bottom
    else if (this.equipProgress >= 0.5) this.equipProgress = 1 - this.equipProgress; // already rising: dip again
  }

  /** @deprecated alias kept for callers that only know blocks */
  setHeldBlock(blockId) { this.setHeldItem(blockId); }

  /** The bow's pulling frame for a draw progress (null when not drawing): pulling_0 from the start, _1 at 65 %, _2 at 90 %. */
  static bowFrameFor(progress) { return progress <= 0 ? null : BOW_FRAMES[progress >= 0.9 ? 2 : progress >= 0.65 ? 1 : 0]; }
  /** The frame index carried in pose bits (0 none, 1–3). */
  static bowFrameIndex(progress) { return progress <= 0 ? 0 : progress >= 0.9 ? 3 : progress >= 0.65 ? 2 : 1; }

  _applyBlock(itemId, frameTexture = null) {
    this.heldBlockId = itemId;
    this.heldFrameTexture = frameTexture;
    if (this.blockMesh) { this.blockMesh.removeFromParent(); this.blockMesh = null; } // tools hang off toolPivot, blocks off blockGroup (geometries are cached, so they are not disposed)
    const item = itemId ? ItemRegistry.get(itemId) : null;
    this.heldIsBow = !!(item && item.bow);
    this.heldIsTool = !!(item && item.tool);
    const asBlock = !!(item && item.isBlock && !BlockRegistry.isTorch(item.blockId)); // torches are held as their item sprite
    this.heldIsBlock = asBlock;
    if (item) {
      const size = asBlock ? 0.3 : 0.5;
      const geom = asBlock ? createBlockGeometry(item.blockId, size) : createItemSpriteGeometry(this.atlas, frameTexture || (item.isBlock ? BlockRegistry.faceTexture(item.blockId, Direction.SOUTH) : item.texture), size);
      this.blockMesh = new THREE.Mesh(geom, this.blockMaterial);
      this.blockMesh.userData.isBlock = asBlock;
      if (this.heldIsBow) {
        this.blockMesh.position.set(0, 0, 0);
        // The 45° roll stands the sprite's diagonal stave up (no lean); the −72° turn about the vertical axis points the
        // wooden curve straight ahead at the crosshair (−43° still faced a little left).
        this.blockMesh.rotation.set(0, -1.25, Math.PI / 4, 'XYZ');
        this.blockGroup.add(this.blockMesh);
      } else if (this.heldIsTool) {
        // Tools: grip at the pivot origin; the head (top-right of the sprite) at (size, size), inside the handle group.
        this.blockMesh.position.set(size / 2, size / 2, 0);
        this.toolHead.position.set(size * 0.92, size * 0.92, 0);
        this.toolHandle.add(this.blockMesh);
      } else {
        // Blocks (cubes), torches and flat items: their old resting pose on the group; the mesh sits above the swing pivot
        // by half its size so the pivot is at the grip, and the pivot is lowered by the same amount so the rest look is unchanged.
        this.blockMesh.position.set(0, size / 2, 0);
        this.swingPivot.position.set(0, -size / 2, 0);
        this.swingPivot.add(this.blockMesh);
      }
    }
    this.armGroup.visible = !item; // every held item, the bow included, hides the arm
    this.blockGroup.visible = !!item;
  }

  swing() { this.swingProgress = 0; }

  /** An arrow left: the bow recoils slightly (no swing). */
  bowKick() { this.kick = 0; }

  /** Brightness factor of the sky light at the player's eyes. */
  setLight(factor) {
    if (sameLight(factor, this._lightFactor) && this._litBlock === this.blockMesh) return;
    this._lightFactor = copyLight(factor, this._lightFactor); this._litBlock = this.blockMesh;
    tintModelLight(this, this.root, factor);
  }

  /** Worn chestplate → textured sleeve box over the arm; worn gauntlets → textured gauntlet box over the fist. */
  setArmor(worn) {
    this.armor = { helmet: null, chestplate: worn && worn.chestplate ? worn.chestplate : null, gauntlets: worn && worn.gauntlets ? worn.gauntlets : null, leggings: null, boots: null };
    applyWornArmor(this.armorMeshes, this.armor, this.entityTextures);
  }

  /** Hand-scene position of whatever is shown (the held block / sprite itself, else the arm) — used by the headless swing / sway check. */
  get shownPosition() {
    if (!this.blockMesh) return this.armGroup.position;
    this.root.updateMatrixWorld(true);
    return this.blockMesh.getWorldPosition(this._shown || (this._shown = new THREE.Vector3()));
  }

  /**
   * Minecraft's attack rotation for a held item at swing progress s: rotateY(i·(45 + f·−20)) · rotateZ(i·f1·−20) ·
   * rotateX(f1·−80) · rotateY(i·−45), composed in that order (each about the then-current local axes).
   */
  _itemSwingQuaternion(s, out) {
    const f = Math.sin(s * s * Math.PI), f1 = Math.sin(Math.sqrt(s) * Math.PI);
    out.setFromAxisAngle(this._axisY, HAND * (45 + f * -20) * DEG);
    out.multiply(this._q2.setFromAxisAngle(this._axisZ, HAND * f1 * -20 * DEG));
    out.multiply(this._q2.setFromAxisAngle(this._axisX, f1 * -80 * DEG));
    out.multiply(this._q2.setFromAxisAngle(this._axisY, HAND * -45 * DEG));
    return out;
  }

  /** World (hand-scene) positions of a held tool's grip and head, or null when no tool is held. */
  toolPoints() {
    if (!this.blockMesh || !this.heldIsTool || this.heldIsBlock) return null;
    this.root.updateMatrixWorld(true);
    return { grip: this.toolGrip.getWorldPosition(new THREE.Vector3()), head: this.toolHead.getWorldPosition(new THREE.Vector3()) };
  }

  /** World direction of the held tool sprite's flat side (its local +Z), or null — the headless edge check. */
  toolFlatNormal() {
    if (!this.blockMesh || !this.heldIsTool || this.heldIsBlock) return null;
    this.root.updateMatrixWorld(true);
    return new THREE.Vector3(0, 0, 1).transformDirection(this.blockMesh.matrixWorld).normalize();
  }

  /**
   * @param {number} dt
   * @param {import('../Player.js').Player} player
   * @param {number} bobPhase
   * @param {number} bobFactor
   */
  update(dt, player, bobPhase, bobFactor) {
    this.time += dt;
    const swimBob = player.swimming ? Math.sin(this.time * 2.2) * 0.02 : 0;
    this.root.visible = this.visible;
    if (!this.visible) return;

    // Equip dip: down, swap, up.
    if (this.equipProgress < 1) {
      this.equipProgress = Math.min(1, this.equipProgress + dt / EQUIP_TIME);
      if (this.equipProgress >= 0.5 && this.pendingBlockId !== this.heldBlockId) this._applyBlock(this.pendingBlockId);
    }
    const equipDip = Math.sin(this.equipProgress * Math.PI) * 0.5;

    // Swing progress s (0 → 1 over 6 ticks); Minecraft's sweep terms.
    if (this.swingProgress < 1) this.swingProgress = Math.min(1, this.swingProgress + dt / SWING_TIME);
    const sp = this.swingProgress;
    const s = sp >= 1 ? 1 : sp;
    const s1 = Math.sin(Math.sqrt(s) * Math.PI);
    const f5 = -0.4 * Math.sin(Math.sqrt(s) * Math.PI), f6 = 0.2 * Math.sin(Math.sqrt(s) * 2 * Math.PI), f10 = -0.2 * Math.sin(s * Math.PI);

    // Look sway: the hand lags behind a fast turn. Turning right lowers yaw (the look direction is
    // (-sin yaw, -cos yaw)), so the hand must move toward -X (left) then; looking up raises pitch and the
    // hand trails down.
    let dYaw = player.yaw - this.lastYaw, dPitch = player.pitch - this.lastPitch;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2; if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.lastYaw = player.yaw; this.lastPitch = player.pitch;
    this.swayX = damp(this.swayX, dYaw * 1.5, 12, dt);
    this.swayY = damp(this.swayY, -dPitch * 1.5, 12, dt);

    const bobX = Math.sin(bobPhase) * HAND_BOB * bobFactor;
    const bobY = -Math.abs(Math.cos(bobPhase)) * HAND_BOB * bobFactor;
    const breathe = Math.sin(this.time * 1.3) * 0.006 + swimBob;

    // The bow: its pulling frame follows the draw progress (swapped without an equip dip).
    if (this.heldIsBow && this.equipProgress >= 1) {
      const frame = FirstPersonHand.bowFrameFor(this.drawProgress);
      if (frame !== this.heldFrameTexture) this._applyBlock(this.heldBlockId, frame);
    }
    const draw = this.heldIsBow ? this.drawProgress : 0;

    // Minecraft's first-person swing (ItemInHandRenderer) for everything held: 1. the sweep (toward the centre, up then
    // down, and in), 2. the item's rest offset, 3. the attack rotations, 4. the item's own rest rotation / pivot — the
    // sweep and the rotations on handSwing, the rest rotation on blockGroup. The same for mining, placing, attacking and
    // swinging at air. The drawn bow does not swing (its own pose below).
    const swinging = sp < 1 && !(this.heldIsBow && draw > 0);
    const hs = this.handSwing;
    const sx = swinging ? HAND * f5 : 0, sy = swinging ? f6 : 0, sz = swinging ? f10 : 0;
    if (swinging) hs.quaternion.copy(this._itemSwingQuaternion(s, this._q)); else hs.quaternion.identity();
    this.swingPivot.rotation.set(0, 0, 0);
    if (this.kick < BOW_KICK_TIME) this.kick += dt;
    const kick = this.kick < BOW_KICK_TIME ? Math.sin(this.kick / BOW_KICK_TIME * Math.PI) : 0;
    if (this.blockMesh && this.heldIsBow) {
      // The bow (its roll + yaw sit on the mesh, see _applyBlock) stands straight up — no lean; the draw moves it toward
      // the centre and tips it up a little while the frames advance. A shot kicks it back and down a little for 0.15 s.
      hs.position.set(0.36 - 0.14 * draw + bobX + this.swayX + sx, -0.3 + 0.04 * draw + bobY + this.swayY - equipDip + breathe + sy - 0.06 * kick, -0.9 - 0.05 * draw + sz + 0.1 * kick);
      this.blockGroup.position.set(0, 0, 0);
      this.blockGroup.rotation.set(0.06 + 0.08 * draw, 0, 0, 'XYZ');
    } else if (this.blockMesh) {
      const g = this.blockGroup;
      g.position.set(0, 0, 0);
      if (this.heldIsTool) {
        // Tools: the rest offset at the fist (bottom right); the pivot at the grip holds the tool with the head up and
        // forward (roll +45° stands the sprite's diagonal up, the pitch tips the top into the screen, the yaw turns it
        // slightly toward the centre).
        hs.position.set(0.58 + bobX + this.swayX + sx, -0.62 + bobY + this.swayY - equipDip + breathe + sy, -0.7 + sz);
        g.rotation.set(0, 0, 0);
        this.toolPivot.rotation.set(-0.55, -0.35, 0, 'YXZ');
      } else if (this.eating > 0) {
        // Eating: the food rises toward the mouth and shakes with each bite.
        const e = Math.min(1, this.eating * 3), bite = Math.sin(this.time * 24) * 0.025 * e;
        hs.position.set(0.5 + bobX + this.swayX - 0.28 * e + sx, -0.42 + bobY + this.swayY - equipDip + breathe + 0.2 * e + bite + sy, -0.78 + 0.3 * e + sz);
        g.rotation.set(0.1 + 0.5 * e, -0.5 - 0.4 * e, -0.15 + bite * 2);
      } else if (this.heldIsBlock) {
        // Blocks: the cube's resting pose (bottom right, turned toward the view).
        hs.position.set(0.5 + bobX + this.swayX + sx, -0.46 + bobY + this.swayY - equipDip + breathe + sy, -0.8 + sz);
        g.rotation.set(0.12, -0.72, 0.05);
      } else {
        // Torches and flat items: the sprite's resting pose (upright, slightly turned, held from the bottom right).
        hs.position.set(0.5 + bobX + this.swayX + sx, -0.42 + bobY + this.swayY - equipDip + breathe + sy, -0.78 + sz);
        g.rotation.set(0.1, -0.5, -0.15);
      }
    } else {
      // Empty hand: the old fist punch, not the Minecraft item swing. The arm rests in the bottom-right corner, tilted
      // about 20° from vertical (its top leaning into the screen and toward the centre), and punches forward toward the
      // crosshair — in, up and deeper into the screen, the top tipping slightly down — then returns, over FIST_SWING_TIME.
      const fp = Math.min(1, sp * SWING_TIME / FIST_SWING_TIME), f1 = Math.sin(Math.sqrt(fp) * Math.PI);
      const g = this.armGroup;
      g.position.set(0.62 + bobX + this.swayX - f1 * 0.32, -1.05 + bobY + this.swayY - equipDip + f1 * 0.2 + breathe, -0.62 - f1 * 0.3);
      g.rotation.set(-0.35 - f1 * 0.55, 0.25 + f1 * 0.2, 0.28 + f1 * 0.15, 'YXZ');
    }
  }
}
