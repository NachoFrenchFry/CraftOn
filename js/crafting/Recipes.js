// Recipes.js — crafting and smelting recipes as data. One line per recipe: what it makes, what it costs,
// and where it can be made ('inventory' = the small list in the inventory screen, 'crafting_table',
// 'furnace'). Names are block or item names from BlockDefinitions / ItemDefinitions. Optional `byproducts`
// are handed back with the result (the obsidian recipe returns its two empty buckets). Never add recipes for
// natural resources (ores, coal, diamonds, dirt, sand…).

export const Station = Object.freeze({ INVENTORY: 'inventory', CRAFTING_TABLE: 'crafting_table', FURNACE: 'furnace' });

const ARMOR_COST = { helmet: 5, chestplate: 8, gauntlets: 4, leggings: 7, boots: 4 };
const ARMOR_MATERIAL = { wooden: 'planks', golden: 'gold_ingot', iron: 'iron_ingot', diamond: 'diamond' };
function armorRecipes() {
  const out = [];
  for (const [prefix, material] of Object.entries(ARMOR_MATERIAL)) for (const [piece, cost] of Object.entries(ARMOR_COST)) {
    out.push({ id: `${prefix}_${piece}`, result: { item: `${prefix}_${piece}`, count: 1 }, inputs: [{ item: material, count: cost }], stations: ['crafting_table'] });
  }
  return out;
}

export const RECIPES = Object.freeze([
  { id: 'planks', result: { item: 'planks', count: 4 }, inputs: [{ item: 'log', count: 1 }], stations: ['inventory', 'crafting_table'] },
  { id: 'crafting_table', result: { item: 'crafting_table', count: 1 }, inputs: [{ item: 'planks', count: 4 }], stations: ['inventory', 'crafting_table'] },
  { id: 'wooden_pickaxe', result: { item: 'wooden_pickaxe', count: 1 }, inputs: [{ item: 'planks', count: 4 }], stations: ['crafting_table'] },
  { id: 'furnace', result: { item: 'furnace', count: 1 }, inputs: [{ item: 'cobblestone', count: 8 }], stations: ['crafting_table'] },
  { id: 'iron_pickaxe', result: { item: 'iron_pickaxe', count: 1 }, inputs: [{ item: 'iron_ingot', count: 3 }, { item: 'planks', count: 2 }], stations: ['crafting_table'] },
  { id: 'diamond_pickaxe', result: { item: 'diamond_pickaxe', count: 1 }, inputs: [{ item: 'diamond', count: 3 }, { item: 'planks', count: 2 }], stations: ['crafting_table'] },
  { id: 'stone_pickaxe', result: { item: 'stone_pickaxe', count: 1 }, inputs: [{ item: 'cobblestone', count: 3 }, { item: 'planks', count: 2 }], stations: ['crafting_table'] },
  { id: 'wooden_sword', result: { item: 'wooden_sword', count: 1 }, inputs: [{ item: 'planks', count: 3 }], stations: ['crafting_table'] },
  { id: 'stone_sword', result: { item: 'stone_sword', count: 1 }, inputs: [{ item: 'cobblestone', count: 2 }, { item: 'planks', count: 1 }], stations: ['crafting_table'] },
  { id: 'iron_sword', result: { item: 'iron_sword', count: 1 }, inputs: [{ item: 'iron_ingot', count: 2 }, { item: 'planks', count: 1 }], stations: ['crafting_table'] },
  { id: 'diamond_sword', result: { item: 'diamond_sword', count: 1 }, inputs: [{ item: 'diamond', count: 2 }, { item: 'planks', count: 1 }], stations: ['crafting_table'] },
  { id: 'bucket', result: { item: 'bucket', count: 1 }, inputs: [{ item: 'iron_ingot', count: 3 }], stations: ['crafting_table'] },
  // Axes (Update #4): same pattern as the pickaxes.
  { id: 'wooden_axe', result: { item: 'wooden_axe', count: 1 }, inputs: [{ item: 'planks', count: 4 }], stations: ['crafting_table'] },
  { id: 'stone_axe', result: { item: 'stone_axe', count: 1 }, inputs: [{ item: 'cobblestone', count: 3 }, { item: 'planks', count: 2 }], stations: ['crafting_table'] },
  { id: 'iron_axe', result: { item: 'iron_axe', count: 1 }, inputs: [{ item: 'iron_ingot', count: 3 }, { item: 'planks', count: 2 }], stations: ['crafting_table'] },
  { id: 'diamond_axe', result: { item: 'diamond_axe', count: 1 }, inputs: [{ item: 'diamond', count: 3 }, { item: 'planks', count: 2 }], stations: ['crafting_table'] },
  // Concrete (Update #5): 4 sand + 4 gravel → 8.
  { id: 'concrete', result: { item: 'concrete', count: 8 }, inputs: [{ item: 'sand', count: 4 }, { item: 'gravel', count: 4 }], stations: ['crafting_table'] },
  // Armor (Update #5): helmet 5, chestplate 8, gauntlets 4, leggings 7, boots 4 of planks / iron ingots / diamonds.
  ...armorRecipes(),
  // Update #11: sticks, torches, the gold tier, storage blocks, building blocks, dyes and the bucket-made obsidian.
  { id: 'stick', result: { item: 'stick', count: 4 }, inputs: [{ item: 'planks', count: 2 }], stations: ['inventory', 'crafting_table'] },
  { id: 'torch', result: { item: 'torch', count: 4 }, inputs: [{ item: 'coal', count: 1 }, { item: 'stick', count: 1 }], stations: ['crafting_table'] },
  { id: 'golden_pickaxe', result: { item: 'golden_pickaxe', count: 1 }, inputs: [{ item: 'gold_ingot', count: 3 }, { item: 'planks', count: 2 }], stations: ['crafting_table'] },
  { id: 'golden_axe', result: { item: 'golden_axe', count: 1 }, inputs: [{ item: 'gold_ingot', count: 3 }, { item: 'planks', count: 2 }], stations: ['crafting_table'] },
  { id: 'golden_sword', result: { item: 'golden_sword', count: 1 }, inputs: [{ item: 'gold_ingot', count: 2 }, { item: 'planks', count: 1 }], stations: ['crafting_table'] },
  { id: 'coal_block', result: { item: 'coal_block', count: 1 }, inputs: [{ item: 'coal', count: 9 }], stations: ['crafting_table'] },
  { id: 'iron_block', result: { item: 'iron_block', count: 1 }, inputs: [{ item: 'iron_ingot', count: 9 }], stations: ['crafting_table'] },
  { id: 'gold_block', result: { item: 'gold_block', count: 1 }, inputs: [{ item: 'gold_ingot', count: 9 }], stations: ['crafting_table'] },
  { id: 'diamond_block', result: { item: 'diamond_block', count: 1 }, inputs: [{ item: 'diamond', count: 9 }], stations: ['crafting_table'] },
  { id: 'coal_from_block', result: { item: 'coal', count: 9 }, inputs: [{ item: 'coal_block', count: 1 }], stations: ['crafting_table'] },
  { id: 'iron_from_block', result: { item: 'iron_ingot', count: 9 }, inputs: [{ item: 'iron_block', count: 1 }], stations: ['crafting_table'] },
  { id: 'gold_from_block', result: { item: 'gold_ingot', count: 9 }, inputs: [{ item: 'gold_block', count: 1 }], stations: ['crafting_table'] },
  { id: 'diamond_from_block', result: { item: 'diamond', count: 9 }, inputs: [{ item: 'diamond_block', count: 1 }], stations: ['crafting_table'] },
  { id: 'bricks', result: { item: 'bricks', count: 4 }, inputs: [{ item: 'clay', count: 4 }, { item: 'stone', count: 1 }], stations: ['crafting_table'] },
  { id: 'stone_bricks', result: { item: 'stone_bricks', count: 4 }, inputs: [{ item: 'stone', count: 4 }], stations: ['crafting_table'] },
  { id: 'wool_red', result: { item: 'wool_red', count: 1 }, inputs: [{ item: 'wool_white', count: 1 }, { item: 'flower_red', count: 1 }], stations: ['crafting_table'] },
  { id: 'wool_blue', result: { item: 'wool_blue', count: 1 }, inputs: [{ item: 'wool_white', count: 1 }, { item: 'flower_blue', count: 1 }], stations: ['crafting_table'] },
  { id: 'grass_block', result: { item: 'grass_block', count: 1 }, inputs: [{ item: 'dirt', count: 1 }, { item: 'grass', count: 1 }], stations: ['crafting_table'] },
  { id: 'snowy_grass', result: { item: 'snowy_grass', count: 1 }, inputs: [{ item: 'dirt', count: 1 }, { item: 'snow', count: 1 }], stations: ['crafting_table'] },
  { id: 'dead_bush', result: { item: 'dead_bush', count: 1 }, inputs: [{ item: 'stick', count: 3 }], stations: ['crafting_table'] },
  // Obsidian only comes from here: the two buckets are emptied and handed back (byproducts).
  { id: 'obsidian', result: { item: 'obsidian', count: 1 }, inputs: [{ item: 'lava_bucket', count: 1 }, { item: 'water_bucket', count: 1 }], byproducts: [{ item: 'bucket', count: 2 }], stations: ['crafting_table'] },
  // Smelting (instant): 1 coal + 1 ore block each.
  { id: 'stone', result: { item: 'stone', count: 1 }, inputs: [{ item: 'cobblestone', count: 1 }, { item: 'coal', count: 1 }], stations: ['furnace'] },
  { id: 'glass', result: { item: 'glass', count: 1 }, inputs: [{ item: 'sand', count: 1 }, { item: 'coal', count: 1 }], stations: ['furnace'] },
  { id: 'cracked_stone_bricks', result: { item: 'cracked_stone_bricks', count: 1 }, inputs: [{ item: 'stone_bricks', count: 1 }, { item: 'coal', count: 1 }], stations: ['furnace'] },
  { id: 'iron_ingot', result: { item: 'iron_ingot', count: 1 }, inputs: [{ item: 'iron_ore', count: 1 }, { item: 'coal', count: 1 }], stations: ['furnace'] },
  { id: 'gold_ingot', result: { item: 'gold_ingot', count: 1 }, inputs: [{ item: 'gold_ore', count: 1 }, { item: 'coal', count: 1 }], stations: ['furnace'] },
  { id: 'diamond', result: { item: 'diamond', count: 1 }, inputs: [{ item: 'diamond_ore', count: 1 }, { item: 'coal', count: 1 }], stations: ['furnace'] },
  // Cooking (Update #9 §8): 1 raw meat + 1 coal.
  { id: 'cooked_beef', result: { item: 'cooked_beef', count: 1 }, inputs: [{ item: 'raw_beef', count: 1 }, { item: 'coal', count: 1 }], stations: ['furnace'] },
  { id: 'cooked_porkchop', result: { item: 'cooked_porkchop', count: 1 }, inputs: [{ item: 'raw_porkchop', count: 1 }, { item: 'coal', count: 1 }], stations: ['furnace'] },
  { id: 'cooked_mutton', result: { item: 'cooked_mutton', count: 1 }, inputs: [{ item: 'raw_mutton', count: 1 }, { item: 'coal', count: 1 }], stations: ['furnace'] },
]);
