// PlacementRules.js — "is something standing there?" checks shared by the local placement code, the guest's
// prediction and the host's validation (Update #9 §2a): a solid block never goes into any player's or mob's
// hitbox. Both sides run the same check, so a guest almost never has a placement rejected for this reason and
// keeps the item either way (GuestClient refunds rejected placements).
import { AABB } from '../utils/AABB.js';
import { PLAYER_WIDTH, PLAYER_HEIGHT, PLAYER_SNEAK_HEIGHT, PLAYER_SWIM_HEIGHT } from '../config/Constants.js';
import { Pose } from '../net/Protocol.js';

const box = new AABB();

/** Hitbox height of a player from its pose bits (crawling / swimming are low, sneaking a little shorter). */
export function playerHeightForPose(pose) {
  if (pose & (Pose.CRAWLING | Pose.SWIMMING)) return PLAYER_SWIM_HEIGHT;
  if (pose & Pose.SNEAKING) return PLAYER_SNEAK_HEIGHT;
  return PLAYER_HEIGHT;
}

/** True when a player standing at (px, py, pz) with the given height overlaps block (x, y, z). */
export function playerBlocksAt(x, y, z, px, py, pz, height) {
  return box.setFromFeet(px, py, pz, PLAYER_WIDTH, height).intersectsBox(x, y, z, x + 1, y + 1, z + 1);
}

/** True when any of the mobs overlaps block (x, y, z). */
export function mobBlocksAt(mobs, x, y, z) {
  for (const m of mobs) {
    if (m.dead) continue;
    const h = m.def.hitbox;
    if (box.setFromFeet(m.position.x, m.position.y, m.position.z, h[0], h[1]).intersectsBox(x, y, z, x + 1, y + 1, z + 1)) return true;
  }
  return false;
}

/** True when any visible remote player (RemotePlayerManager) overlaps block (x, y, z). */
export function remotePlayersBlockAt(manager, x, y, z) {
  if (!manager) return false;
  for (const rp of manager.players.values()) {
    const st = rp.state;
    if (st.spectator || !rp.interp.hasData) continue;
    const pose = (st.crawling ? Pose.CRAWLING : 0) | (st.swimming ? Pose.SWIMMING : 0) | (st.sneaking ? Pose.SNEAKING : 0);
    const p = rp.position;
    if (playerBlocksAt(x, y, z, p.x, p.y, p.z, playerHeightForPose(pose))) return true;
  }
  return false;
}
