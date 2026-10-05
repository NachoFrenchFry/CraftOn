// MobNet.js — the Minecraft box-UV "net" layout, shared by the model builder, the sheet painter and the
// overlap check. For a box W×H×D with net origin (u, v): top (u+D, v) W×D, bottom (u+D+W, v) W×D,
// right (u, v+D) D×H, front (u+D, v+D) W×H, left (u+D+W, v+D) D×H, back (u+2D+W, v+D) W×H. Pure.

/** Face rectangles {name, x, y, w, h} of a box net. */
export function netRects(u, v, W, H, D) {
  return [
    { name: 'top', x: u + D, y: v, w: W, h: D },
    { name: 'bottom', x: u + D + W, y: v, w: W, h: D },
    { name: 'right', x: u, y: v + D, w: D, h: H },
    { name: 'front', x: u + D, y: v + D, w: W, h: H },
    { name: 'left', x: u + D + W, y: v + D, w: D, h: H },
    { name: 'back', x: u + 2 * D + W, y: v + D, w: W, h: H },
  ];
}

/** Distinct nets used by a definition (parts sharing the same uv + size count once). */
export function definitionNets(def) {
  const seen = new Map();
  for (const part of def.parts) {
    const key = `${part.layer || 'base'}:${part.uv[0]},${part.uv[1]},${part.size.join('x')}`;
    if (!seen.has(key)) seen.set(key, { part: part.name, layer: part.layer || 'base', rects: netRects(part.uv[0], part.uv[1], part.size[0], part.size[1], part.size[2]) });
  }
  return [...seen.values()];
}

/** Overlap / bounds problems for a definition's nets on a sheet: [] when valid. */
export function checkNets(def, sheetW, sheetH) {
  const problems = [];
  const nets = definitionNets(def);
  const byLayer = new Map();
  for (const n of nets) { if (!byLayer.has(n.layer)) byLayer.set(n.layer, []); byLayer.get(n.layer).push(n); }
  for (const [layer, list] of byLayer) {
    const all = [];
    for (const n of list) for (const r of n.rects) {
      if (r.x < 0 || r.y < 0 || r.x + r.w > sheetW || r.y + r.h > sheetH) problems.push(`${def.type}/${layer}: ${n.part} ${r.name} outside ${sheetW}×${sheetH}`);
      all.push({ ...r, part: n.part });
    }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) problems.push(`${def.type}/${layer}: ${a.part} ${a.name} overlaps ${b.part} ${b.name}`);
    }
  }
  return problems;
}
