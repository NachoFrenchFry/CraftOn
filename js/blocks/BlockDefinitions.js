// BlockDefinitions.js — the data table describing every block. Add a block here (and an id in
// BlockIds.js, a texture painter if needed) and the registry, items, icons and mesher pick it up.
// Worker-safe (pure data).

import { BlockIds as B } from './BlockIds.js';
import { SoundGroup as S } from './BlockSoundGroups.js';

/**
 * Field reference:
 *  textures: { all } | { top, bottom, side } | { top, bottom, north, south, east, west }
 *  opaque: blocks vision (hidden-face culling); solid: collides with the player
 *  renderType: 'cube' | 'cross' | 'liquid'; pass: 'opaque' | 'cutout' | 'translucent'
 *  breakTime: seconds without tools; Infinity = unbreakable
 *  drops: block name or null; dropChance: optional probability (default 1)
 *  placeable: appears as an item; creativeOnly: only in the creative catalog
 *  needsSupport: breaks when the block below is removed (plants, cactus)
 *  stoneType: pickaxes mine it faster; woodType: axes mine it faster (log, planks, crafting table, hay bale)
 *  station: 'crafting_table' | 'furnace' opens a screen on right click
 *  cullSameType: false keeps faces between two blocks of this type ("fancy" leaves)
 *  base / facing: rotated variants of a station block (only the base is an item)
 *  axis: 'x' | 'z' log variants (base 'log' is vertical); rotateFaces: faces whose texture turns 90° so the
 *  bark grain runs along the log's axis
 */

/** The four facing variants of a block with a front texture; the base (facing south) is the item. */
function facingVariants(baseId, name, displayName, tex, props) {
  const facings = [['', 'south', baseId], ['_n', 'north', baseId + 1], ['_e', 'east', baseId + 2], ['_w', 'west', baseId + 3]];
  return facings.map(([suffix, facing, id]) => {
    const faces = { north: tex.side, south: tex.side, east: tex.side, west: tex.side };
    faces[facing] = tex.front;
    return {
      id, name: name + suffix, displayName, base: name, facing,
      textures: { top: tex.top, bottom: tex.bottom, ...faces },
      opaque: true, solid: true, renderType: 'cube', pass: 'opaque', drops: name,
      placeable: suffix === '', hidden: suffix !== '', ...props,
    };
  });
}

/** Flowing / falling water variants share the source's properties but are never items. */
function waterVariant(id, name) {
  return { id, name, displayName: 'Water', textures: { all: 'water' }, opaque: false, solid: false, renderType: 'liquid', pass: 'translucent', breakTime: Infinity, soundGroup: S.WATER, drops: null, placeable: false, hidden: true };
}
export const BLOCK_DEFINITIONS = [
  { id: B.AIR, name: 'air', displayName: 'Air', textures: null, opaque: false, solid: false, renderType: 'none', pass: 'opaque', breakTime: 0, soundGroup: S.STONE, drops: null, placeable: false },
  { id: B.STONE, name: 'stone', displayName: 'Stone', textures: { all: 'stone' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'cobblestone', placeable: true, stoneType: true },
  { id: B.GRASS_BLOCK, name: 'grass_block', displayName: 'Grass Block', textures: { top: 'grass_block_top', bottom: 'dirt', side: 'grass_block_side' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.5, soundGroup: S.GRASS, drops: 'dirt', placeable: true },
  { id: B.DIRT, name: 'dirt', displayName: 'Dirt', textures: { all: 'dirt' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.5, soundGroup: S.DIRT, drops: 'dirt', placeable: true },
  { id: B.COBBLESTONE, name: 'cobblestone', displayName: 'Cobblestone', textures: { all: 'cobblestone' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'cobblestone', placeable: true, stoneType: true },
  { id: B.PLANKS, name: 'planks', displayName: 'Planks', textures: { all: 'planks' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 1.5, soundGroup: S.WOOD, drops: 'planks', placeable: true, woodType: true },
  { id: B.BEDROCK, name: 'bedrock', displayName: 'Bedrock', textures: { all: 'bedrock' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: Infinity, soundGroup: S.STONE, drops: null, placeable: true, creativeOnly: true },
  { id: B.WATER, name: 'water', displayName: 'Water', textures: { all: 'water' }, opaque: false, solid: false, renderType: 'liquid', pass: 'translucent', breakTime: Infinity, soundGroup: S.WATER, drops: null, placeable: true, creativeOnly: true },
  { id: B.SAND, name: 'sand', displayName: 'Sand', textures: { all: 'sand' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.5, soundGroup: S.SAND, drops: 'sand', placeable: true },
  { id: B.GRAVEL, name: 'gravel', displayName: 'Gravel', textures: { all: 'gravel' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.5, soundGroup: S.DIRT, drops: 'gravel', placeable: true },
  { id: B.GOLD_ORE, name: 'gold_ore', displayName: 'Gold Ore', textures: { all: 'gold_ore' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'gold_ore', placeable: true, stoneType: true },
  { id: B.IRON_ORE, name: 'iron_ore', displayName: 'Iron Ore', textures: { all: 'iron_ore' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'iron_ore', placeable: true, stoneType: true },
  { id: B.COAL_ORE, name: 'coal_ore', displayName: 'Coal Ore', textures: { all: 'coal_ore' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'coal', placeable: true, stoneType: true },
  { id: B.LOG, name: 'log', displayName: 'Log', textures: { top: 'log_top', bottom: 'log_top', side: 'log_side' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 1.5, soundGroup: S.WOOD, drops: 'log', placeable: true, woodType: true, axis: 'y' },
  // Horizontal logs (placed against east/west or north/south faces): end grain on the axis faces, bark elsewhere
  // with the side texture rotated where the face's texture V axis is not the log axis.
  { id: B.LOG_X, name: 'log_x', displayName: 'Log', base: 'log', axis: 'x', textures: { east: 'log_top', west: 'log_top', top: 'log_side', bottom: 'log_side', north: 'log_side', south: 'log_side' }, rotateFaces: ['up', 'down', 'north', 'south'], opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 1.5, soundGroup: S.WOOD, drops: 'log', placeable: false, woodType: true },
  { id: B.LOG_Z, name: 'log_z', displayName: 'Log', base: 'log', axis: 'z', textures: { north: 'log_top', south: 'log_top', top: 'log_side', bottom: 'log_side', east: 'log_side', west: 'log_side' }, rotateFaces: ['east', 'west'], opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 1.5, soundGroup: S.WOOD, drops: 'log', placeable: false, woodType: true },
  { id: B.LEAVES, name: 'leaves', displayName: 'Leaves', textures: { all: 'leaves' }, opaque: false, solid: true, renderType: 'cube', pass: 'cutout', cullSameType: false, breakTime: 0.2, soundGroup: S.PLANT, drops: 'leaves', dropChance: 0.05, placeable: true },
  { id: B.GLASS, name: 'glass', displayName: 'Glass', textures: { all: 'glass' }, opaque: false, solid: true, renderType: 'cube', pass: 'cutout', breakTime: 0.4, soundGroup: S.GLASS, drops: null, placeable: true },
  { id: B.SANDSTONE, name: 'sandstone', displayName: 'Sandstone', textures: { top: 'sandstone_top', bottom: 'sandstone_top', side: 'sandstone_side' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'sandstone', placeable: true, stoneType: true },
  { id: B.GRASS, name: 'grass', displayName: 'Grass', textures: { all: 'grass' }, opaque: false, solid: false, renderType: 'cross', pass: 'cutout', breakTime: 0, soundGroup: S.PLANT, drops: null, placeable: true, needsSupport: true },
  { id: B.FLOWER_YELLOW, name: 'flower_yellow', displayName: 'Dandelion', textures: { all: 'flower_yellow' }, opaque: false, solid: false, renderType: 'cross', pass: 'cutout', breakTime: 0, soundGroup: S.PLANT, drops: 'flower_yellow', placeable: true, needsSupport: true },
  { id: B.FLOWER_RED, name: 'flower_red', displayName: 'Poppy', textures: { all: 'flower_red' }, opaque: false, solid: false, renderType: 'cross', pass: 'cutout', breakTime: 0, soundGroup: S.PLANT, drops: 'flower_red', placeable: true, needsSupport: true },
  { id: B.BRICKS, name: 'bricks', displayName: 'Bricks', textures: { all: 'bricks' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'bricks', placeable: true, stoneType: true },
  { id: B.SNOW, name: 'snow', displayName: 'Snow Block', textures: { all: 'snow' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.5, soundGroup: S.SNOW, drops: 'snow', placeable: true },
  { id: B.SNOWY_GRASS, name: 'snowy_grass', displayName: 'Snowy Grass Block', textures: { top: 'snow', bottom: 'dirt', side: 'grass_block_snow_side' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.5, soundGroup: S.SNOW, drops: 'dirt', placeable: true },
  { id: B.CLAY, name: 'clay', displayName: 'Clay', textures: { all: 'clay' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.5, soundGroup: S.DIRT, drops: 'clay', placeable: true },
  { id: B.CACTUS, name: 'cactus', displayName: 'Cactus', textures: { top: 'cactus_top', bottom: 'cactus_top', side: 'cactus_side' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.4, soundGroup: S.PLANT, drops: 'cactus', placeable: true, needsSupport: true },
  { id: B.STONE_BRICKS, name: 'stone_bricks', displayName: 'Stone Bricks', textures: { all: 'stone_bricks' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'stone_bricks', placeable: true, stoneType: true },
  { id: B.DIAMOND_ORE, name: 'diamond_ore', displayName: 'Diamond Ore', textures: { all: 'diamond_ore' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'diamond_ore', placeable: true, stoneType: true },
  { id: B.ICE, name: 'ice', displayName: 'Ice', textures: { all: 'ice' }, opaque: false, solid: true, renderType: 'cube', pass: 'translucent', breakTime: 0.5, soundGroup: S.GLASS, drops: null, placeable: true },
  { id: B.DEAD_BUSH, name: 'dead_bush', displayName: 'Dead Bush', textures: { all: 'dead_bush' }, opaque: false, solid: false, renderType: 'cross', pass: 'cutout', breakTime: 0, soundGroup: S.PLANT, drops: null, placeable: true, needsSupport: true },
  // Decorative full cubes (Update #1). Only mossy cobblestone appears in world generation (cave walls).
  { id: B.MOSSY_COBBLESTONE, name: 'mossy_cobblestone', displayName: 'Mossy Cobblestone', textures: { all: 'mossy_cobblestone' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'mossy_cobblestone', placeable: true, stoneType: true },
  { id: B.CRACKED_STONE_BRICKS, name: 'cracked_stone_bricks', displayName: 'Cracked Stone Bricks', textures: { all: 'cracked_stone_bricks' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 2.0, soundGroup: S.STONE, drops: 'cracked_stone_bricks', placeable: true, stoneType: true },
  { id: B.OBSIDIAN, name: 'obsidian', displayName: 'Obsidian', textures: { all: 'obsidian' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 4.0, soundGroup: S.STONE, drops: 'obsidian', placeable: true, stoneType: true },
  { id: B.HAY_BALE, name: 'hay_bale', displayName: 'Hay Bale', textures: { top: 'hay_bale_top', bottom: 'hay_bale_top', side: 'hay_bale_side' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.5, soundGroup: S.GRASS, drops: 'hay_bale', placeable: true, woodType: true },
  { id: B.CONCRETE, name: 'concrete', displayName: 'Concrete', textures: { all: 'concrete' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 1.5, soundGroup: S.STONE, drops: 'concrete', placeable: true, stoneType: true },
  { id: B.WOOL_WHITE, name: 'wool_white', displayName: 'White Wool', textures: { all: 'wool_white' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.8, soundGroup: S.SNOW, drops: 'wool_white', placeable: true },
  { id: B.WOOL_RED, name: 'wool_red', displayName: 'Red Wool', textures: { all: 'wool_red' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.8, soundGroup: S.SNOW, drops: 'wool_red', placeable: true },
  { id: B.WOOL_BLUE, name: 'wool_blue', displayName: 'Blue Wool', textures: { all: 'wool_blue' }, opaque: true, solid: true, renderType: 'cube', pass: 'opaque', breakTime: 0.8, soundGroup: S.SNOW, drops: 'wool_blue', placeable: true },
  // Flowing water (Update #2). The source is WATER above; these carry the level in the id.
  waterVariant(B.FLOWING_WATER_1, 'flowing_water_1'), waterVariant(B.FLOWING_WATER_2, 'flowing_water_2'),
  waterVariant(B.FLOWING_WATER_3, 'flowing_water_3'), waterVariant(B.FLOWING_WATER_4, 'flowing_water_4'),
  waterVariant(B.FLOWING_WATER_5, 'flowing_water_5'), waterVariant(B.FLOWING_WATER_6, 'flowing_water_6'),
  waterVariant(B.FLOWING_WATER_7, 'flowing_water_7'), waterVariant(B.FALLING_WATER, 'falling_water'),
  // Stations (Update #2): right click opens a screen; the front faces the player when placed.
  ...facingVariants(B.CRAFTING_TABLE, 'crafting_table', 'Crafting Table',
    { top: 'crafting_table_top', bottom: 'planks', front: 'crafting_table_front', side: 'crafting_table_side' },
    { breakTime: 1.5, soundGroup: S.WOOD, station: 'crafting_table', woodType: true }),
  ...facingVariants(B.FURNACE, 'furnace', 'Furnace',
    { top: 'furnace_top', bottom: 'furnace_top', front: 'furnace_front', side: 'furnace_side' },
    { breakTime: 2.0, soundGroup: S.STONE, station: 'furnace', stoneType: true }),
];
