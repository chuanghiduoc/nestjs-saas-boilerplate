// Vùng sở hữu (spec SP7 §6.1) cho init.mjs và sync.mjs. check.mjs giữ bản riêng cùng luật vì phải là MỘT file chạy
// được từ stdin; test của cả ba công cụ chạy trên cùng .upstream/zones.json.
export const ZONE_NAMES = [
  'boilerplate',
  'project',
  'template',
  'generated',
  'shared',
];

export class ZonesError extends Error {}

function matches(pattern, path) {
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}
const weight = (pattern) =>
  pattern.endsWith('*') ? pattern.length - 1 : pattern.length;

/**
 * Tiền tố dài nhất thắng; không khớp mục nào → vùng dự án (không tường minh). `pattern`: mục của `zones.json` đã thắng
 * (sync giữ vùng template đã xoá theo từng mục).
 */
export function zoneOf(zones, path) {
  let best;
  for (const e of zones.entries)
    if (
      matches(e.pattern, path) &&
      (!best || weight(e.pattern) > weight(best.pattern))
    )
      best = e;
  return best
    ? { zone: best.zone, explicit: true, pattern: best.pattern }
    : { zone: 'project', explicit: false, pattern: undefined };
}

export function parseZones(text, source) {
  let z;
  try {
    z = JSON.parse(text);
  } catch (e) {
    throw new ZonesError(
      `${source}: invalid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (z?.version !== 1) throw new ZonesError(`${source}: "version" must be 1`);
  const entries = [];
  const owner = new Map();
  for (const zone of ZONE_NAMES) {
    const list = z[zone];
    if (
      !Array.isArray(list) ||
      list.some((p) => typeof p !== 'string' || p === '')
    )
      throw new ZonesError(
        `${source}: "${zone}" must be an array of non-empty strings`,
      );
    for (const pattern of list) {
      if (owner.has(pattern))
        throw new ZonesError(
          `${source}: "${pattern}" is listed in both ${owner.get(pattern)} and ${zone}`,
        );
      owner.set(pattern, zone);
      entries.push({ pattern, zone });
    }
  }
  const zones = { entries, projectSeed: new Set() };
  if (!Array.isArray(z.projectSeed))
    throw new ZonesError(`${source}: "projectSeed" must be an array`);
  for (const seed of z.projectSeed) {
    const at = zoneOf(zones, seed);
    if (!at.explicit || at.zone !== 'project')
      throw new ZonesError(
        `${source}: projectSeed "${seed}" is not an explicit project-zone path`,
      );
    zones.projectSeed.add(seed);
  }
  return zones;
}
