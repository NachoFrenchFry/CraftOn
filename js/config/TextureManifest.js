// TextureManifest.js — the single source of truth for texture files. Every texture the game uses is a
// 16×16 PNG in textures/ (cracks in textures/cracks/). The game loads them all from disk;
// tools/export-textures.mjs regenerates the procedural ones from tools/texture-recipes/.
// Importable from Node (no DOM).

export const TEXTURE_DIR = 'textures/';
export const CRACK_STAGES = 10;

/** The six hand-made textures. The export tool never overwrites these, even with --force. */
export const ORIGINAL_TEXTURES = Object.freeze(['grass_block_top', 'grass_block_side', 'stone', 'log_top', 'log_side', 'leaves']);
/** Generated once, then hand-edited by the author: the exporter never rewrites these either. */
export const EDITED_TEXTURES = Object.freeze(['grass_block_snow_side', 'grass', 'torch_side']);

/** Textures produced by the recipes in tools/texture-recipes/ (flat files in textures/). */
export const GENERATED_TEXTURES = Object.freeze([
  'dirt', 'sand', 'gravel', 'clay', 'bedrock', 'cobblestone', 'snow', 'grass_block_snow_side',
  'sandstone_top', 'sandstone_side', 'planks', 'glass', 'bricks', 'stone_bricks', 'water', 'ice',
  'cactus_top', 'cactus_side',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore',
  'grass', 'flower_red', 'flower_yellow', 'dead_bush',
  'mossy_cobblestone', 'cracked_stone_bricks', 'obsidian', 'concrete',
  'wool_white', 'wool_red', 'wool_blue',
  // stations and items
  'crafting_table_top', 'crafting_table_side', 'crafting_table_front', 'furnace_front', 'furnace_side', 'furnace_top',
  'coal', 'iron_ingot', 'gold_ingot', 'diamond', 'wooden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe',
  // tools, buckets, meats
  'stone_pickaxe', 'wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword', 'bucket', 'water_bucket',
  'raw_beef', 'raw_mutton', 'raw_porkchop', 'raw_chicken', 'feather',
  // cooked meats
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  // axes
  'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe',
  // armor and spawn eggs
  'wooden_helmet', 'wooden_chestplate', 'wooden_gauntlets', 'wooden_leggings', 'wooden_boots',
  'iron_helmet', 'iron_chestplate', 'iron_gauntlets', 'iron_leggings', 'iron_boots',
  'diamond_helmet', 'diamond_chestplate', 'diamond_gauntlets', 'diamond_leggings', 'diamond_boots',
  'cow_spawn_egg', 'pig_spawn_egg', 'sheep_spawn_egg', 'chicken_spawn_egg',
  // particle sprite
  'crit_star',
  // lava, sticks, torches, the gold tier, the cornflower, storage blocks
  'lava', 'lava_bucket', 'stick', 'torch_side', 'torch_top', 'flower_blue',
  'golden_pickaxe', 'golden_axe', 'golden_sword', 'golden_helmet', 'golden_chestplate', 'golden_gauntlets', 'golden_leggings', 'golden_boots',
  'coal_block', 'iron_block', 'gold_block', 'diamond_block',
  // string, the bow and its draw frames, arrows, explosives
  'string', 'bow', 'bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2', 'arrow', 'explosives_top', 'explosives_side', 'explosives_bottom',
]);

/**
 * Atlas textures that are neither a block face nor an item icon (particle sprites). AtlasLayout adds them to
 * the atlas explicitly — a name only listed in GENERATED_TEXTURES is exported but never packed (a fix
 * for the checkerboard crit stars).
 */
export const PARTICLE_TEXTURES = Object.freeze(['crit_star']);
/** Held-item frames that are not an item's own icon (the bow's pulling frames): packed into the atlas for the held sprites. */
export const HELD_FRAME_TEXTURES = Object.freeze(['bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2']);
/** Tiles the atlas derives from other tiles at load time (no file): fast leaves = leaves with the holes filled. */
export const DERIVED_TEXTURES = Object.freeze(['leaves_fast']);
export const EXTRA_ATLAS_TEXTURES = Object.freeze([...PARTICLE_TEXTURES, ...HELD_FRAME_TEXTURES, ...DERIVED_TEXTURES]);

/**
 * Entity sheets in textures/entity/ (not part of the atlas): the mob sheets (64×32 Minecraft-style box-UV nets), the
 * player skin and the zombie (64×64, the standard Minecraft skin layout, see js/player/models/SkinLayout.js) and the arrow.
 */
export const ENTITY_TEXTURES = Object.freeze(['cow', 'pig', 'sheep', 'sheep_wool', 'chicken', 'zombie', 'player', 'arrow']);
export const ENTITY_TEXTURE_SIZE = Object.freeze([64, 32]);
/** Sheets that are not 64×32. */
export const ENTITY_TEXTURE_SIZES = Object.freeze({ zombie: [64, 64], player: [64, 64], arrow: [16, 16] });
export const SKIN_SIZE = Object.freeze([64, 64]);
/**
 * Armor sheets in textures/entity/armor/: per material `<m>_layer_1.png` holds the helmet,
 * chestplate (+ sleeves), gauntlets and boots nets, `<m>_layer_2.png` the leggings (waist + upper legs).
 * 64×32 box-UV nets like the mobs; see js/player/models/ArmorModel.js for the rectangles.
 */
export const ARMOR_SHEET_MATERIALS = Object.freeze(['wooden', 'golden', 'iron', 'diamond']);
export const ARMOR_TEXTURES = Object.freeze(ARMOR_SHEET_MATERIALS.flatMap((m) => [`${m}_layer_1`, `${m}_layer_2`]));
export const ARMOR_TEXTURE_SIZE = Object.freeze([64, 32]);

/** name → path for every texture file. */
export const TEXTURE_FILES = (() => {
  const files = {};
  for (const name of ORIGINAL_TEXTURES) files[name] = `${TEXTURE_DIR}${name}.png`;
  for (const name of GENERATED_TEXTURES) files[name] = `${TEXTURE_DIR}${name}.png`;
  for (let i = 0; i < CRACK_STAGES; i++) files[`crack_${i}`] = `${TEXTURE_DIR}cracks/crack_${i}.png`;
  for (const name of ENTITY_TEXTURES) files[`entity/${name}`] = `${TEXTURE_DIR}entity/${name}.png`;
  for (const name of ARMOR_TEXTURES) files[`entity/armor/${name}`] = `${TEXTURE_DIR}entity/armor/${name}.png`;
  return Object.freeze(files);
})();

export function texturePath(name) {
  return TEXTURE_FILES[name] || null;
}
