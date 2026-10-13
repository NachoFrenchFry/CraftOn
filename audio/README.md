# CraftOn sounds

Every sound the game plays is a plain audio file in this folder, one **folder per sound** with numbered variations
inside, exactly like the textures in `textures/`:

```
audio/
  manifest.json              which files belong to which sound (generated, see below)
  breaking/stone/1.wav       a stone block breaks, variation 1
  breaking/stone/2.wav       … the game picks one variation at random each time
  walking/grass/1.wav
  mobs/cow/hurt/1.wav
  ambient/wind/1.wav         a seamless stereo loop
  ui/click/1.wav
```

Replace any file with your own recording to change that sound: keep the folder, use any file name, and reload the game
(the files are fetched with `cache: 'reload'`, so no hard refresh is needed). Add more variations by dropping in more
files, remove some by deleting them. Every time you **add or remove** a file, run

```
python3 tools/update_audio_manifest.py
```

so `manifest.json` lists the new set (replacing a file under the same name needs nothing). The manifest keeps the
`volume` (a multiplier, 1.0 by default) and `loop` flags you set by hand:

```json
"breaking/stone": { "files": ["1.wav", "2.wav", "3.wav", "4.wav"], "volume": 1.0 },
"ambient/wind":   { "files": ["1.wav"], "volume": 1.0, "loop": true }
```

The files shipped here were rendered from the old synthesis recipes by `python3 tools/export_sounds.py`
(headless Chrome, `tools/sound-recipes/`); the export never overwrites a file that exists unless you pass `--force`, so
your edited sounds survive a re-export. The game itself never synthesizes anything: a sound whose folder is empty, or
whose files fail to load, simply stays silent and is listed once in the console (`SoundBank: … could not be loaded`).

## Every sound

"When it plays" describes the game event; the length is a suggestion so the sound fits the animation (the game also
shifts the pitch of every effect by ±10 % at random, and all sounds follow `/tick rate`). The last column is how many
variations are in the folder right now.

| Sound (folder under `audio/`) | When it plays | Suggested length | Loops | Files now |
|---|---|---|---|---|
| `walking/stone` | a footstep on a stone block (the player, other players, mobs) | 0.1–0.3 s | no | 4 |
| `breaking/stone` | a stone block breaks | 0.3–0.6 s | no | 4 |
| `placing/stone` | a stone block is placed | 0.2–0.4 s | no | 4 |
| `mining/stone` | the chipping while holding the mouse on a stone block (every 0.25 s) | 0.1–0.3 s | no | 4 |
| `walking/dirt` | a footstep on a dirt block (the player, other players, mobs) | 0.1–0.3 s | no | 4 |
| `breaking/dirt` | a dirt block breaks | 0.3–0.6 s | no | 4 |
| `placing/dirt` | a dirt block is placed | 0.2–0.4 s | no | 4 |
| `mining/dirt` | the chipping while holding the mouse on a dirt block (every 0.25 s) | 0.1–0.3 s | no | 4 |
| `walking/grass` | a footstep on a grass block (the player, other players, mobs) | 0.1–0.3 s | no | 4 |
| `breaking/grass` | a grass block breaks | 0.3–0.6 s | no | 4 |
| `placing/grass` | a grass block is placed | 0.2–0.4 s | no | 4 |
| `mining/grass` | the chipping while holding the mouse on a grass block (every 0.25 s) | 0.1–0.3 s | no | 4 |
| `walking/sand` | a footstep on a sand block (the player, other players, mobs) | 0.1–0.3 s | no | 4 |
| `breaking/sand` | a sand block breaks | 0.3–0.6 s | no | 4 |
| `placing/sand` | a sand block is placed | 0.2–0.4 s | no | 4 |
| `mining/sand` | the chipping while holding the mouse on a sand block (every 0.25 s) | 0.1–0.3 s | no | 4 |
| `walking/wood` | a footstep on a wood block (the player, other players, mobs) | 0.1–0.3 s | no | 4 |
| `breaking/wood` | a wood block breaks | 0.3–0.6 s | no | 4 |
| `placing/wood` | a wood block is placed | 0.2–0.4 s | no | 4 |
| `mining/wood` | the chipping while holding the mouse on a wood block (every 0.25 s) | 0.1–0.3 s | no | 4 |
| `walking/plant` | a footstep on a plant block (the player, other players, mobs) | 0.1–0.3 s | no | 4 |
| `breaking/plant` | a plant block breaks | 0.3–0.6 s | no | 4 |
| `placing/plant` | a plant block is placed | 0.2–0.4 s | no | 4 |
| `mining/plant` | the chipping while holding the mouse on a plant block (every 0.25 s) | 0.1–0.3 s | no | 4 |
| `walking/glass` | a footstep on a glass block (the player, other players, mobs) | 0.1–0.3 s | no | 4 |
| `breaking/glass` | a glass block breaks | 0.3–0.6 s | no | 4 |
| `placing/glass` | a glass block is placed | 0.2–0.4 s | no | 4 |
| `mining/glass` | the chipping while holding the mouse on a glass block (every 0.25 s) | 0.1–0.3 s | no | 4 |
| `walking/snow` | a footstep on a snow block (the player, other players, mobs) | 0.1–0.3 s | no | 4 |
| `breaking/snow` | a snow block breaks | 0.3–0.6 s | no | 4 |
| `placing/snow` | a snow block is placed | 0.2–0.4 s | no | 4 |
| `mining/snow` | the chipping while holding the mouse on a snow block (every 0.25 s) | 0.1–0.3 s | no | 4 |
| `walking/water` | a footstep on a water block (the player, other players, mobs) | 0.1–0.3 s | no | 4 |
| `breaking/water` | a water block breaks | 0.3–0.6 s | no | 4 |
| `placing/water` | a water block is placed | 0.2–0.4 s | no | 4 |
| `mining/water` | the chipping while holding the mouse on a water block (every 0.25 s) | 0.1–0.3 s | no | 4 |
| `player/jump` | the player jumps (reserved: the game currently plays a quiet footstep) | 0.1–0.2 s | no | 3 |
| `player/land` | the player lands after a fall (reserved: the game plays a pitched-down footstep) | 0.2–0.4 s | no | 3 |
| `player/hurt` | the player takes damage | 0.2–0.4 s | no | 3 |
| `player/death` | the player dies | 0.5–1 s | no | 3 |
| `player/crit` | a critical hit on a mob (with the star burst) | 0.2–0.3 s | no | 3 |
| `player/eat` | each chew while eating (every 0.28 s) | 0.1–0.2 s | no | 3 |
| `player/eat_done` | eating finished | 0.3–0.5 s | no | 3 |
| `player/burn` | reserved for burning (not played yet) | 0.3–0.5 s | no | 3 |
| `player/splash` | entering water fast | 0.5–1 s | no | 3 |
| `player/swim` | a swim stroke (every 0.6 s while swimming) | 0.3–0.6 s | no | 3 |
| `player/equip_wood` | putting on wooden armor | 0.2–0.3 s | no | 3 |
| `player/equip_metal` | putting on iron or diamond armor | 0.2–0.4 s | no | 3 |
| `items/pickup` | an item is picked up, a spawn egg is used | 0.1–0.2 s | no | 3 |
| `items/drop` | an item is thrown (Q) | 0.2–0.3 s | no | 3 |
| `items/bucket_fill` | a bucket scoops water or lava | 0.4–0.6 s | no | 3 |
| `items/bucket_empty` | a bucket is poured out | 0.5–0.9 s | no | 3 |
| `mobs/cow/ambient` | a cow calls now and then (every 8–25 s) | 0.5–1.5 s | no | 3 |
| `mobs/cow/hurt` | a cow is hit | 0.3–0.6 s | no | 3 |
| `mobs/cow/death` | a cow dies | 0.8–2 s | no | 3 |
| `mobs/pig/ambient` | a pig calls now and then (every 8–25 s) | 0.5–1.5 s | no | 3 |
| `mobs/pig/hurt` | a pig is hit | 0.3–0.6 s | no | 3 |
| `mobs/pig/death` | a pig dies | 0.8–2 s | no | 3 |
| `mobs/sheep/ambient` | a sheep calls now and then (every 8–25 s) | 0.5–1.5 s | no | 3 |
| `mobs/sheep/hurt` | a sheep is hit | 0.3–0.6 s | no | 3 |
| `mobs/sheep/death` | a sheep dies | 0.8–2 s | no | 3 |
| `liquids/lava_pop` | reserved for lava bubbles (not played yet) | 0.3–0.6 s | no | 3 |
| `liquids/lava_sizzle` | lava meets water (cobblestone forms), an item burns | 0.5–1 s | no | 3 |
| `ambient/wind` | the wind bed, always on, louder high up and quieter indoors or under water | 20–30 s | yes (seamless, stereo) | 1 |
| `ambient/water` | the bubbling bed near water, fades in and out | 8–15 s | yes (seamless, stereo) | 1 |
| `ambient/cave` | a deep cave tone, rarely, when enclosed below y 50 | 2–4 s | no | 3 |
| `ambient/drip` | a water drip with reverb, rarely, when enclosed below y 50 | 1–3 s | no | 3 |
| `ui/click` | any menu or inventory button, hotbar swaps | 0.05–0.1 s | no | 3 |
| `ui/hover` | the mouse enters a menu button | 0.02–0.05 s | no | 3 |
| `ui/inventory_open` | the inventory, crafting table or furnace screen opens | 0.1–0.2 s | no | 3 |
| `ui/inventory_close` | that screen closes | 0.1–0.2 s | no | 3 |
| `ui/craft` | an item is crafted | 0.2–0.3 s | no | 3 |
| `ui/smelt` | an item is smelted in the furnace | 0.4–0.6 s | no | 3 |

## Tips

- **Formats**: `.wav` and `.mp3` play in every browser. `.ogg` works in Chrome, Firefox and Edge but Safari skips some
  Ogg files, and `.m4a` depends on the OS decoders, so prefer `.wav` (short effects) or `.mp3` (long loops) for files
  that have to work everywhere. The exported files are 16-bit PCM WAV at 44.1 kHz, mono for effects and stereo for the
  loops.
- **Levels**: normalise effects to about −2 dBFS peak (the export uses 0.8 of full scale) and set a quieter sound with
  `volume` in the manifest rather than re-rendering. Keep 2–3 ms fades at both ends so nothing clicks.
- **Loops** (`"loop": true`): the file must start and end on the same sound level so the seam is inaudible; crossfade the
  tail into the head in your editor (the export crossfades 2 s). 20–30 s of wind or water hides the repetition well.
- **Variations**: 3–4 takes of a footstep or a block sound stop it from sounding mechanical; one is enough for the loops
  and the rare UI sounds.
- **Spatial sounds** (blocks, mobs, other players, drips) are positioned with a PannerNode, so render them mono: a stereo
  file is mixed down before it is placed in the world.
- **Volume buses**: Options → Audio has sliders for Master, Blocks, Player, Ambient and UI; a sound's bus is decided by
  the code, not by the file.
