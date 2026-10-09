// FirstPersonHand.js — the first-person arm and held block rendered in an overlay scene: forward swing
// (toward the crosshair), equip dip, view bobbing, look sway that trails the turn, idle breathing, and the
// worn chestplate sleeve / gauntlet as real inflated, textured boxes on the arm (Update #7). Tools are
// gripped at the bottom of the handle and swing around that grip, so the head arcs forward and down onto
// the crosshair (Update #6).

import * as THREE from 'three';
import { createPart, COLORS, createModelLights, setToolHandleRotation, tintModelLight } from './ModelParts.js';
import { buildFirstPersonArmor, applyWornArmor } from './ArmorModel.js';
import { createBlockGeometry } from '../../rendering/BlockGeometry.js';
import { BlockRegistry } from '../../blocks/BlockRegistry.js';
import { Direction } from '../../utils/Direction.js';
import { sameLight, copyLight } from '../../rendering/LightUniforms.js';
import { createItemSpriteGeometry } from '../../rendering/ItemSpriteGeometry.js';
import { ItemRegistry } from '../../items/ItemRegistry.js';
import { HAND_BOB } from '../../config/Constants.js';
import { damp } from '../../utils/MathUtils.js';

const SWING_TIME = 0.25;
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

    // Arm: 4×12×4 px box (sleeve + fist) whose local +Y runs from the shoulder (below the screen) to
    // the fist. It gets a fixed Minecraft-like base transform: bottom right, pointing forward into the
    // screen and slightly up toward the center, only ~20° from vertical.
    this.armGroup = new THREE.Group();
    const sleeve = createPart(4, 8, 4, COLORS.shirt, [0, 4, 0]);
    const hand = createPart(4.05, 4.4, 4.05, COLORS.skin, [0, 10.2, 0]);
    this.sleeveMesh = sleeve.mesh;
    this.handMesh = hand.mesh;
    this.armGroup.add(sleeve.mesh, hand.mesh);
    // Worn chestplate sleeve and gauntlet: textured boxes over the sleeve and the fist (hidden until worn).
    this.armorMeshes = buildFirstPersonArmor(this.armGroup);
    this.armor = { helmet: null, chestplate: null, gauntlets: null, leggings: null, boots: null };
    this.armGroup.scale.setScalar(1.35);
    this.root.add(this.armGroup);

    this.blockGroup = new THREE.Group();
    this.root.add(this.blockGroup);
    // Tools sit inside a pivot placed at the grip (the sprite's bottom-left corner): the mesh is offset by
    // half its size so rotating the pivot swings the head around the wrist. Inside the pivot a handle group
    // rolls the sprite 45° (handle up) and turns it 90° about the handle so the point / edge leads the
    // swing (Update #8). Two markers give the grip and head positions to the headless check.
    this.toolPivot = new THREE.Group();
    this.blockGroup.add(this.toolPivot);
    this.toolHandle = setToolHandleRotation(new THREE.Group());
    this.toolPivot.add(this.toolHandle);
    this.toolGrip = new THREE.Object3D();
    this.toolHead = new THREE.Object3D();
    this.toolHandle.add(this.toolGrip, this.toolHead);
    this.blockMesh = null;
    this.heldBlockId = -1;

    this.swingProgress = 1;
    /** Eating progress 0..1 (Update #9 §8): the food bobs toward the mouth. */
    this.eating = 0;
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

  _applyBlock(itemId) {
    this.heldBlockId = itemId;
    if (this.blockMesh) { this.blockMesh.removeFromParent(); this.blockMesh = null; } // tools hang off toolPivot, blocks off blockGroup (geometries are cached, so they are not disposed)
    const item = itemId ? ItemRegistry.get(itemId) : null;
    this.heldIsTool = !!(item && item.tool);
    if (item) {
      const asBlock = item.isBlock && !BlockRegistry.isTorch(item.blockId); // torches are held as their item sprite (Update #11)
      const size = asBlock ? 0.3 : 0.5;
      const geom = asBlock ? createBlockGeometry(item.blockId, size) : createItemSpriteGeometry(this.atlas, item.isBlock ? BlockRegistry.faceTexture(item.blockId, Direction.SOUTH) : item.texture, size);
      this.blockMesh = new THREE.Mesh(geom, this.blockMaterial);
      this.blockMesh.userData.isBlock = asBlock;
      if (this.heldIsTool) {
        // Grip at the pivot origin; the head (top-right of the sprite) at (size, size), inside the handle group.
        this.blockMesh.position.set(size / 2, size / 2, 0);
        this.toolHead.position.set(size * 0.92, size * 0.92, 0);
        this.toolHandle.add(this.blockMesh);
      } else {
        this.blockMesh.position.set(0, 0, 0);
        this.blockGroup.add(this.blockMesh);
      }
    }
    this.armGroup.visible = !item;
    this.blockGroup.visible = !!item;
  }

  swing() { this.swingProgress = 0; }

  /** Brightness factor of the sky light at the player's eyes (Update #10). */
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

  /** Hand-scene position of whatever is shown (arm or held item) — used by the headless swing / sway check. */
  get shownPosition() { return this.blockMesh ? this.blockGroup.position : this.armGroup.position; }

  /** World (hand-scene) positions of a held tool's grip and head, or null when no tool is held. */
  toolPoints() {
    if (!this.blockMesh || !this.heldIsTool) return null;
    this.root.updateMatrixWorld(true);
    return { grip: this.toolGrip.getWorldPosition(new THREE.Vector3()), head: this.toolHead.getWorldPosition(new THREE.Vector3()) };
  }

  /** World direction of the held tool sprite's flat side (its local +Z), or null — the headless edge check. */
  toolFlatNormal() {
    if (!this.blockMesh || !this.heldIsTool) return null;
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

    // Swing arc.
    if (this.swingProgress < 1) this.swingProgress = Math.min(1, this.swingProgress + dt / SWING_TIME);
    const sp = this.swingProgress;
    const s1 = Math.sin(Math.sqrt(sp) * Math.PI);

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

    // The swing punches forward: toward the crosshair (x and y move toward the screen centre), deeper
    // into the screen (-z), with the top tipping forward and slightly down; then it returns.
    if (this.blockMesh && this.blockMesh.userData.isBlock) {
      const g = this.blockGroup;
      g.position.set(0.5 + bobX + this.swayX - s1 * 0.3, -0.46 + bobY + this.swayY - equipDip + s1 * 0.14 + breathe, -0.8 - s1 * 0.22);
      g.rotation.set(0.12 + s1 * 0.6, -0.72 - s1 * 0.9, 0.05 + s1 * 0.2);
    } else if (this.blockMesh) {
      const g = this.blockGroup;
      if (this.heldIsTool) {
        // Tools: the group sits at the fist (bottom right) and only bobs / sways; the pivot at the grip
        // holds the tool with the head up and forward (roll +45° stands the sprite's diagonal up, the pitch
        // tips the top into the screen, the yaw turns it slightly toward the centre). The swing rotates the
        // pivot around the wrist so the head arcs forward and down onto the crosshair, then returns.
        g.position.set(0.58 + bobX + this.swayX - s1 * 0.06, -0.62 + bobY + this.swayY - equipDip + breathe, -0.7);
        g.rotation.set(0, 0, 0);
        this.toolPivot.rotation.set(-0.55 - s1 * 1.45, -0.35 + s1 * 0.35, 0, 'YXZ'); // the 45° roll + edge turn live in toolHandle
      } else if (this.eating > 0) {
        // Eating: the food rises toward the mouth and shakes with each bite.
        const e = Math.min(1, this.eating * 3), bite = Math.sin(this.time * 24) * 0.025 * e;
        g.position.set(0.5 + bobX + this.swayX - 0.28 * e, -0.42 + bobY + this.swayY - equipDip + breathe + 0.2 * e + bite, -0.78 + 0.3 * e);
        g.rotation.set(0.1 + 0.5 * e, -0.5 - 0.4 * e, -0.15 + bite * 2);
      } else {
        // Other items: a sprite held from the bottom right, punched toward the crosshair.
        g.position.set(0.5 + bobX + this.swayX - s1 * 0.3, -0.42 + bobY + this.swayY - equipDip + s1 * 0.14 + breathe, -0.78 - s1 * 0.22);
        g.rotation.set(0.1 + s1 * 0.6, -0.5 - s1 * 0.6, -0.15);
      }
    } else {
      // Empty hand: fixed base pose (Minecraft-like) with bob / sway / equip / swing layered on top.
      // The swing punches forward and a little toward the center, then returns.
      const g = this.armGroup;
      g.position.set(
        0.62 + bobX + this.swayX - s1 * 0.32,
        -1.05 + bobY + this.swayY - equipDip + s1 * 0.2 + breathe,
        -0.62 - s1 * 0.3,
      );
      // Tilt: top of the arm leans away into the screen (x) and toward the center (z), ~20° from vertical.
      g.rotation.set(-0.35 - s1 * 0.55, 0.25 + s1 * 0.2, 0.28 + s1 * 0.15, 'YXZ');
    }
  }
}
