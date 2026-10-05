// BlockSoundGroups.js — the sound groups blocks belong to. Each group has break/place/hit/step sounds
// synthesized in audio/recipes/BlockSounds.js. Worker-safe (pure data).

export const SoundGroup = Object.freeze({
  STONE: 'stone',
  DIRT: 'dirt',
  GRASS: 'grass',
  SAND: 'sand',
  WOOD: 'wood',
  PLANT: 'plant',
  GLASS: 'glass',
  SNOW: 'snow',
  WATER: 'water',
});

export const SOUND_GROUP_LIST = Object.freeze(Object.values(SoundGroup));

/** Relative loudness per group so no material is jarring. */
export const SOUND_GROUP_GAIN = Object.freeze({
  stone: 0.9,
  dirt: 0.9,
  grass: 0.85,
  sand: 0.7,
  wood: 0.9,
  plant: 0.6,
  glass: 0.8,
  snow: 0.75,
  water: 0.8,
});
