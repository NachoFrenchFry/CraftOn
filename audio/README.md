# CraftOn sounds

Every sound the game plays is **one plain audio file** in this folder, `audio/<category>/<sound>.<ext>`, exactly like
the textures in `textures/`:

```
audio/
  manifest.json              which file belongs to which sound, with its volume and variation (generated, see below)
  breaking/stone.wav         a stone block breaks
  walking/grass.wav          a footstep on grass
  player/jump.wav
  mobs/cow/hurt.wav
  ambient/wind.wav           a seamless stereo loop
  ui/inventory_close.wav
  _old_variations/           the extra generated takes that were set aside; delete the folder whenever you like
```

There is one file per sound: the game varies it in code. Every play shifts the **pitch** (playback rate) and the
**volume** by a random amount, and never repeats the exact pitch of the previous play of that sound, so fast footsteps or
mining never sound robotic. `/tick rate` scaling multiplies on top. How much a sound may vary is set per sound in
`manifest.json`:

```json
"breaking/stone": { "file": "stone.wav", "volume": 1.0, "pitch": 0.12, "volumeVar": 0.1, "loop": false },
"ambient/wind":   { "file": "wind.wav",  "volume": 1.0, "pitch": 0.0,  "volumeVar": 0.0, "loop": true }
```

- `file` — the file next to the manifest entry's folder (any name; `.wav`, `.mp3`, `.ogg` or `.m4a`).
- `volume` — the base gain multiplier (1.0 = as recorded); make a sound quieter here rather than re-exporting it.
- `pitch` — the random playback-rate shift per play, as a fraction: `0.12` means ±12 %.
- `volumeVar` — the random gain change per play: `0.1` means ±10 %.
- `loop` — the game loops this file (the wind and water beds).

Defaults when a sound is new to the manifest, by category:

| Category | Pitch | Volume |
|---|---|---|
| breaking / placing / mining / walking | ±12 % | ±10 % |
| mobs | ±10 % | ±5 % |
| player hurt / crit / land / splash / swim | ±8 % | ±5 % |
| items (pickup, drop, buckets) | ±6 % | ±5 % |
| other player sounds, liquids, cave / drip | ±5 % | ±5 % |
| ui (click, hover, inventory open / close, craft, smelt) | 0 % | 0 % |
| ambient loops (wind, water) | 0 % | 0 % |

Replace any file with your own recording to change that sound: keep the folder and reload the game (the files are
fetched with `cache: 'reload'`, so no hard refresh is needed). Every time you **add, remove or rename** a file, run

```
python3 tools/update_audio_manifest.py
```

so `manifest.json` lists the new set; it keeps the `volume`, `pitch`, `volumeVar` and `loop` values you set and
ignores `_old_variations/`. Replacing a file under the same name needs nothing.

The files shipped here were rendered from synthesis recipes by `python3 tools/export_sounds.py` (headless Chrome,
`tools/sound-recipes/`), one per sound; the export never overwrites a file that exists unless you pass `--force`, so
your edited sounds survive a re-export. The game itself never synthesizes anything: a sound whose file is missing or
fails to load simply stays silent and is listed once in the console (`SoundBank: … could not be loaded`).

## Every sound

"When it plays" describes the game event; the length is a suggestion so the sound fits the animation. The last two
columns are the variation the manifest gives each sound right now.

| Sound (`audio/<id>.wav`) | When it plays | Suggested length | Loops | Pitch ± | Volume ± |
|---|---|---|---|---|---|
| `walking/stone` | a footstep on a stone block (the player, other players, mobs) | 0.1–0.3 s | no | 12 % | 10 % |
| `breaking/stone` | a stone block breaks | 0.3–0.6 s | no | 12 % | 10 % |
| `placing/stone` | a stone block is placed | 0.2–0.4 s | no | 12 % | 10 % |
| `mining/stone` | the chipping while holding the mouse on a stone block (every 0.25 s) | 0.1–0.3 s | no | 12 % | 10 % |
| `walking/dirt` | a footstep on a dirt block (the player, other players, mobs) | 0.1–0.3 s | no | 12 % | 10 % |
| `breaking/dirt` | a dirt block breaks | 0.3–0.6 s | no | 12 % | 10 % |
| `placing/dirt` | a dirt block is placed | 0.2–0.4 s | no | 12 % | 10 % |
| `mining/dirt` | the chipping while holding the mouse on a dirt block (every 0.25 s) | 0.1–0.3 s | no | 12 % | 10 % |
| `walking/grass` | a footstep on a grass block (the player, other players, mobs) | 0.1–0.3 s | no | 12 % | 10 % |
| `breaking/grass` | a grass block breaks | 0.3–0.6 s | no | 12 % | 10 % |
| `placing/grass` | a grass block is placed | 0.2–0.4 s | no | 12 % | 10 % |
| `mining/grass` | the chipping while holding the mouse on a grass block (every 0.25 s) | 0.1–0.3 s | no | 12 % | 10 % |
| `walking/sand` | a footstep on a sand block (the player, other players, mobs) | 0.1–0.3 s | no | 12 % | 10 % |
| `breaking/sand` | a sand block breaks | 0.3–0.6 s | no | 12 % | 10 % |
| `placing/sand` | a sand block is placed | 0.2–0.4 s | no | 12 % | 10 % |
| `mining/sand` | the chipping while holding the mouse on a sand block (every 0.25 s) | 0.1–0.3 s | no | 12 % | 10 % |
| `walking/wood` | a footstep on a wood block (the player, other players, mobs) | 0.1–0.3 s | no | 12 % | 10 % |
| `breaking/wood` | a wood block breaks | 0.3–0.6 s | no | 12 % | 10 % |
| `placing/wood` | a wood block is placed | 0.2–0.4 s | no | 12 % | 10 % |
| `mining/wood` | the chipping while holding the mouse on a wood block (every 0.25 s) | 0.1–0.3 s | no | 12 % | 10 % |
| `walking/plant` | a footstep on a plant block (the player, other players, mobs) | 0.1–0.3 s | no | 12 % | 10 % |
| `breaking/plant` | a plant block breaks | 0.3–0.6 s | no | 12 % | 10 % |
| `placing/plant` | a plant block is placed | 0.2–0.4 s | no | 12 % | 10 % |
| `mining/plant` | the chipping while holding the mouse on a plant block (every 0.25 s) | 0.1–0.3 s | no | 12 % | 10 % |
| `walking/glass` | a footstep on a glass block (the player, other players, mobs) | 0.1–0.3 s | no | 12 % | 10 % |
| `breaking/glass` | a glass block breaks | 0.3–0.6 s | no | 12 % | 10 % |
| `placing/glass` | a glass block is placed | 0.2–0.4 s | no | 12 % | 10 % |
| `mining/glass` | the chipping while holding the mouse on a glass block (every 0.25 s) | 0.1–0.3 s | no | 12 % | 10 % |
| `walking/snow` | a footstep on a snow block (the player, other players, mobs) | 0.1–0.3 s | no | 12 % | 10 % |
| `breaking/snow` | a snow block breaks | 0.3–0.6 s | no | 12 % | 10 % |
| `placing/snow` | a snow block is placed | 0.2–0.4 s | no | 12 % | 10 % |
| `mining/snow` | the chipping while holding the mouse on a snow block (every 0.25 s) | 0.1–0.3 s | no | 12 % | 10 % |
| `walking/water` | a footstep on a water block (the player, other players, mobs) | 0.1–0.3 s | no | 12 % | 10 % |
| `breaking/water` | a water block breaks | 0.3–0.6 s | no | 12 % | 10 % |
| `placing/water` | a water block is placed | 0.2–0.4 s | no | 12 % | 10 % |
| `mining/water` | the chipping while holding the mouse on a water block (every 0.25 s) | 0.1–0.3 s | no | 12 % | 10 % |
| `player/jump` | the player jumps (reserved: the game currently plays a quiet footstep) | 0.1–0.2 s | no | 5 % | 5 % |
| `player/land` | the player lands after a fall (reserved: the game plays a pitched-down footstep) | 0.2–0.4 s | no | 8 % | 5 % |
| `player/hurt` | the player takes damage | 0.2–0.4 s | no | 8 % | 5 % |
| `player/death` | the player dies | 0.5–1 s | no | 5 % | 5 % |
| `player/crit` | a critical hit on a mob (with the star burst) | 0.2–0.3 s | no | 8 % | 5 % |
| `player/eat` | each chew while eating (every 0.28 s) | 0.1–0.2 s | no | 5 % | 5 % |
| `player/eat_done` | eating finished | 0.3–0.5 s | no | 5 % | 5 % |
| `player/burn` | reserved for burning (not played yet) | 0.3–0.5 s | no | 5 % | 5 % |
| `player/splash` | entering water fast | 0.5–1 s | no | 8 % | 5 % |
| `player/swim` | a swim stroke (every 0.6 s while swimming) | 0.3–0.6 s | no | 8 % | 5 % |
| `player/equip_wood` | putting on wooden armor | 0.2–0.3 s | no | 5 % | 5 % |
| `player/equip_metal` | putting on iron or diamond armor | 0.2–0.4 s | no | 5 % | 5 % |
| `items/pickup` | an item is picked up, a spawn egg is used | 0.1–0.2 s | no | 6 % | 5 % |
| `items/drop` | an item is thrown (Q) | 0.2–0.3 s | no | 6 % | 5 % |
| `items/bucket_fill` | a bucket scoops water or lava | 0.4–0.6 s | no | 6 % | 5 % |
| `items/bucket_empty` | a bucket is poured out | 0.5–0.9 s | no | 6 % | 5 % |
| `items/bow_draw` | the bow starts to draw (right click held) | 0.3–0.6 s | no | 6 % | 5 % |
| `items/bow_shoot` | an arrow leaves the bow | 0.2–0.4 s | no | 6 % | 5 % |
| `items/arrow_hit_block` | an arrow sticks into a block | 0.1–0.3 s | no | 6 % | 5 % |
| `items/arrow_hit_entity` | an arrow hits a mob or a player | 0.1–0.3 s | no | 6 % | 5 % |
| `explosives/explosion` | an explosive goes off | 1–2 s | no | 5 % | 5 % |
| `mobs/cow/ambient` | a cow calls now and then (every 8–25 s) | 0.5–1.5 s | no | 10 % | 5 % |
| `mobs/cow/hurt` | a cow is hit | 0.3–0.6 s | no | 10 % | 5 % |
| `mobs/cow/death` | a cow dies | 0.8–2 s | no | 10 % | 5 % |
| `mobs/pig/ambient` | a pig calls now and then (every 8–25 s) | 0.5–1.5 s | no | 10 % | 5 % |
| `mobs/pig/hurt` | a pig is hit | 0.3–0.6 s | no | 10 % | 5 % |
| `mobs/pig/death` | a pig dies | 0.8–2 s | no | 10 % | 5 % |
| `mobs/sheep/ambient` | a sheep calls now and then (every 8–25 s) | 0.5–1.5 s | no | 10 % | 5 % |
| `mobs/sheep/hurt` | a sheep is hit | 0.3–0.6 s | no | 10 % | 5 % |
| `mobs/sheep/death` | a sheep dies | 0.8–2 s | no | 10 % | 5 % |
| `mobs/zombie/ambient` | a zombie groans (every 6–20 s) | 0.8–1.5 s | no | 10 % | 5 % |
| `mobs/zombie/hurt` | a zombie is hit | 0.3–0.6 s | no | 10 % | 5 % |
| `mobs/zombie/death` | a zombie dies | 1–2 s | no | 10 % | 5 % |
| `liquids/lava_pop` | reserved for lava bubbles (not played yet) | 0.3–0.6 s | no | 5 % | 5 % |
| `liquids/lava_sizzle` | lava meets water (cobblestone forms), an item burns | 0.5–1 s | no | 5 % | 5 % |
| `ambient/wind` | the wind bed, always on, louder high up and quieter indoors or under water | 20–30 s | yes (seamless, stereo) | 0 % | 0 % |
| `ambient/water` | the bubbling bed near water, fades in and out | 8–15 s | yes (seamless, stereo) | 0 % | 0 % |
| `ambient/cave` | a deep cave tone, rarely, when enclosed below y 50 | 2–4 s | no | 5 % | 5 % |
| `ambient/drip` | a water drip with reverb, rarely, when enclosed below y 50 | 1–3 s | no | 5 % | 5 % |
| `ui/click` | any menu or inventory button, hotbar swaps | 0.05–0.1 s | no | 0 % | 0 % |
| `ui/hover` | the mouse enters a menu button | 0.02–0.05 s | no | 0 % | 0 % |
| `ui/inventory_open` | the inventory, crafting table or furnace screen opens | 0.1–0.2 s | no | 0 % | 0 % |
| `ui/inventory_close` | that screen closes | 0.1–0.2 s | no | 0 % | 0 % |
| `ui/craft` | an item is crafted | 0.2–0.3 s | no | 0 % | 0 % |
| `ui/smelt` | an item is smelted in the furnace | 0.4–0.6 s | no | 0 % | 0 % |

## Tips

- **Formats**: `.wav` and `.mp3` play in every browser. `.ogg` works in Chrome, Firefox and Edge but Safari skips some
  Ogg files, and `.m4a` depends on the OS decoders, so prefer `.wav` (short effects) or `.mp3` (long loops) for files
  that have to work everywhere. The exported files are 16-bit PCM WAV at 44.1 kHz, mono for effects and stereo for the
  loops.
- **Levels**: normalise effects to about −2 dBFS peak (the export uses 0.8 of full scale) and set a quieter sound with
  `volume` in the manifest rather than re-rendering. Keep 2–3 ms fades at both ends so nothing clicks.
- **Loops** (`"loop": true`): the file must start and end on the same sound level so the seam is inaudible; crossfade the
  tail into the head in your editor (the export crossfades 2 s). 20–30 s of wind or water hides the repetition well.
- **One take is enough**: the pitch and volume variation makes a single footstep or block sound feel different every
  time; raise `pitch` for more variety or set it to 0 for a sound that must always play the same (UI sounds do).
- **Spatial sounds** (blocks, mobs, other players, drips) are positioned with a PannerNode, so render them mono: a stereo
  file is mixed down before it is placed in the world.
- **Volume buses**: Options → Audio has sliders for Master, Blocks, Player, Ambient and UI; a sound's bus is decided by
  the code, not by the file.
