// Constants.js — world dimensions, physics constants and other tunables shared by every subsystem.
// Worker-safe: no DOM, no Three.js.

export const CHUNK_SIZE = 16;
export const CHUNK_SHIFT = 4;
export const CHUNK_MASK = 15;
export const WORLD_HEIGHT = 256;
export const SECTION_SIZE = 16;
export const SECTION_COUNT = WORLD_HEIGHT / SECTION_SIZE;
export const BLOCKS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;
export const SEA_LEVEL = 62;
export const MIN_TERRAIN_HEIGHT = 5;
/** Caves never carve below this, so bedrock (y ≤ 4) is never exposed. */
export const MIN_CAVE_Y = 8;
export const MAX_TERRAIN_HEIGHT = 225;

/** Padded chunk copy used by the mesher: 18 x 18 columns, full height. */
export const PADDED_SIZE = CHUNK_SIZE + 2;
export const PADDED_STRIDE_Z = PADDED_SIZE;
export const PADDED_STRIDE_Y = PADDED_SIZE * PADDED_SIZE;
export const PADDED_LENGTH = PADDED_STRIDE_Y * WORLD_HEIGHT;

// ---- Player physics (blocks, seconds) ----
export const PHYSICS_HZ = 60;
export const PHYSICS_STEP = 1 / PHYSICS_HZ;
export const MAX_PHYSICS_STEPS = 5;
export const MAX_FRAME_DT = 0.1;

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_SNEAK_HEIGHT = 1.5;
export const PLAYER_EYE_HEIGHT = 1.62;
export const PLAYER_SNEAK_EYE_HEIGHT = 1.27;
/** Swimming / crawling pose: a 0.6 cube so the player fits through 1-block gaps. */
export const PLAYER_SWIM_HEIGHT = 0.6;
export const PLAYER_SWIM_EYE_HEIGHT = 0.4;
/** Time constant for smooth pose / camera height changes. */
export const POSE_TRANSITION_SECONDS = 0.25;

export const WALK_SPEED = 4.317;
export const SPRINT_SPEED = 5.612;
export const SNEAK_SPEED = 1.31;
export const FLY_SPEED = 10.9;
export const SPRINT_FLY_SPEED = 21.6;
export const SWIM_SPEED = 2.0;          // ordinary movement while in water
export const SWIM_SPRINT_SPEED = 5.5;   // sprint-swimming along the look direction

export const GRAVITY = 32;
export const TERMINAL_VELOCITY = 78;
export const JUMP_VELOCITY = 10.55;     // measured apex ≈ 1.65 blocks with GRAVITY 32 at 60 Hz
export const SPRINT_JUMP_BOOST = 1.6;
export const WATER_GRAVITY = 6;
export const WATER_TERMINAL_VELOCITY = 3;
export const SWIM_UP_SPEED = 3.2;
export const SWIM_GRAVITY = 1.0;        // gravity while sprint-swimming (mostly cancelled)
export const WATER_JUMP_FACTOR = 0.9;   // grounded jump in shallow water
/** Climbing out of water: upward speed while pressing against a ledge, max ledge rise, grace after leaving water. */
export const WATER_LEDGE_BOOST = 7.0;
export const WATER_CLIMB_MAX_RISE = 1.5;     // shore up to one block above the water block (feet float ~0.2 below the surface)
export const WATER_CLIMB_GRACE = 0.5;
export const SWIM_STROKE_INTERVAL = 0.6;
export const COLLISION_EPSILON = 1e-4;
export const VOID_Y = -64;

export const REACH_SURVIVAL = 5;
export const REACH_CREATIVE = 6;
export const PLACE_REPEAT_SECONDS = 0.25;

// ---- Chunk streaming ----
/**
 * Chunks are generated out to renderDistance + GENERATION_MARGIN so that every chunk inside the
 * render circle has all 8 neighbours (needed for meshing); the farthest diagonal neighbour of a
 * chunk at distance r lies at r + sqrt(2) ≈ r + 1.414.
 */
export const GENERATION_MARGIN = 1.5;
/** Chunks are unloaded beyond renderDistance + GENERATION_MARGIN + UNLOAD_MARGIN. */
export const UNLOAD_MARGIN = 2;
export const INTEGRATION_BUDGET_MS = 4;
export const MAX_MESH_UPLOADS_PER_FRAME = 6;

// ---- Items / entities ----
export const MAX_STACK = 64;
export const ITEM_PICKUP_DELAY = 0.25;         // mined drops
export const ITEM_THROW_PICKUP_DELAY = 1.5;    // thrown items
export const ITEM_PICKUP_EXPAND_XZ = 1.0;      // an item is picked up when its box touches the player's hitbox grown by this
export const ITEM_PICKUP_EXPAND_Y = 0.5;
export const ITEM_DESPAWN_SECONDS = 300;

// ---- Rendering ----
export const SKY_COLOR = 0x87ceeb;
export const WATER_FOG_COLOR = 0x1a4fb8;
export const FACE_BRIGHTNESS = [0.6, 0.6, 1.0, 0.5, 0.8, 0.8]; // indexed by Direction id
export const AO_BRIGHTNESS = [0.5, 0.7, 0.85, 1.0];
export const WATER_SURFACE_HEIGHT = 0.875;   // source water with air above

// ---- Flowing water ----
export const WATER_TICK_SECONDS = 0.25;        // scheduled water update interval (5 game ticks)
export const MAX_WATER_UPDATES_PER_TICK = 300; // cap so floods never lag the game
export const WATER_SLOPE_SEARCH = 4;           // blocks to search for a drop when choosing flow directions
export const WATER_MAX_LEVEL = 7;              // flowing level 7 is the weakest; 8 dries up
// Lava (Update #11): slow thick updates, 3 blocks of spread, dense orange fog, damage numbers in player/Damage.js.
export const LAVA_TICK_SECONDS = 1.5;
export const LAVA_FOG_COLOR = 0xd84a0c;
export const LAVA_FOG_NEAR = 0.2;
export const LAVA_FOG_FAR = 3.5;
export const LAVA_SPEED_FACTOR = 0.35;        // of the water swim speed
export const LAVA_UP_SPEED = 1.6;             // slow climb while holding jump
export const LAVA_POOL_CAVERN_BLOCKS = 350;   // cheese-carved blocks in a chunk before its floor basins may hold lava
export const LAVA_POOL_MAX_Y = 25;
export const LAVA_POOL_MAX_CELLS = 48;
export const LAVA_POOL_CHANCE = 0.7;          // per qualifying chunk
export const DESERT_LAKE_CHANCE = 1 / 50;     // per all-desert chunk (about 1 per 40–60 desert chunks)
export const WATER_PUSH_ACCEL = 14;            // player push (settles at ≈1.2 b/s against water drag)
export const ITEM_WATER_PUSH = 5;              // item entity push acceleration
export const ITEM_BUOYANCY = 14;               // item entities float up in water

// ---- Spectator ----
export const SPECTATOR_SPEED_MIN = 0.5;
export const SPECTATOR_SPEED_MAX = 5;
export const SPECTATOR_SPEED_STEP = 1.25;   // wheel multiplier per notch

// ---- Combat / mobs ----
export const HAND_ATTACK_DAMAGE = 1;
export const ATTACK_REACH = 3.5;
export const MOB_KNOCKBACK = 4.5;
export const MOB_KNOCKBACK_UP = 3;
export const MOB_HURT_FLASH_SECONDS = 0.4;
export const MOB_INVULNERABLE_SECONDS = 0.5;
export const MOB_PANIC_SECONDS = 5;
export const MOB_DEATH_SECONDS = 1;
export const MOB_AI_INTERVAL = 0.25;
export const MOB_CAP = 40;
export const MOB_SPAWN_CHANCE = 1 / 6;
export const MOB_WANDER_RADIUS = 10;
export const MOB_MAX_DROP = 3;
export const MOB_JUMP_VELOCITY = 8.6;
export const MOB_PX = 1 / 16;                // 1 texture pixel = 1/16 block

// ---- Caves (Update #3: Caves & Cliffs style) ----
export const CAVE_CHUNK_CHANCE = 3;          // worm systems spawn in 1 of N source chunks
export const CAVE_ROOM_CHANCE = 3;           // 1 in N systems start with a big room
export const SPAGHETTI_THRESHOLD = 0.09;
export const SPAGHETTI2_THRESHOLD = 0.075;    // second, finer spaghetti layer (scale 1/40)
export const NOODLE_THRESHOLD = 0.035;       // thin noodle caves (scale 1/25)
export const CHEESE_THRESHOLD = 0.65;        // big caverns up to y 50; the threshold rises above that
export const CHEESE_TOP_Y = 50;
export const PILLAR_THRESHOLD = 0.55;
// Cave springs (Update #5): single water sources in cavern walls, 1–3 per chunk that holds a big cavern.
export const CAVE_SPRING_MIN = 1;
export const CAVE_SPRING_MAX = 3;
export const CAVE_SPRING_CAVERN_BLOCKS = 600;   // cheese-carved blocks in a chunk that count as a big cavern        // 2D noise above this leaves stone columns inside caverns
// Ravines (Update #8): 1 of N chunks rolls a start; about half the rolls land on water and are dropped, so
// roughly one ravine begins per 2N chunks of land.
export const RAVINE_CHUNK_CHANCE = 10;
/** Mountain surfaces (Update #8): snow caps from here up; bare stone summits (with snow patches) higher still. */
export const SNOW_LINE_Y = 150;
export const STONY_PEAK_Y = 190;

// ---- Underwater view ----
export const UNDERWATER_FOG_NEAR = 4;
export const UNDERWATER_FOG_FAR = 44;
export const UNDERWATER_SKY_TINT = 0.45;       // blend of the sky / sun colors toward the water color

// ---- View bobbing (values at the default 50% intensity; Update #8 doubled them and slowed the cycle) ----
export const BOB_SIDE = 0.025;
export const BOB_VERTICAL = 0.04;
export const BOB_ROLL = 0.007;
export const HAND_BOB = 0.045;
export const BOB_DEFAULT_INTENSITY = 50;
/** Bob phase advance per block walked (was π × 1.15; about 35 % slower now). */
export const BOB_PHASE_PER_BLOCK = Math.PI * 0.75;

export const HAND_FOV = 70;
