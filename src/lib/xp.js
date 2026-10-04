export const XP_MIN = 15;
export const XP_MAX = 25;
export const XP_COOLDOWN_MS = 60_000;

// XP necesaria para pasar del nivel `level` al siguiente.
export function xpToNext(level) {
  return 5 * level * level + 50 * level + 100;
}

export function levelFromXp(totalXp) {
  let level = 0;
  let progress = totalXp;
  while (progress >= xpToNext(level)) {
    progress -= xpToNext(level);
    level++;
  }
  return { level, progress, needed: xpToNext(level) };
}

export function randomXp(rng = Math.random) {
  return XP_MIN + Math.floor(rng() * (XP_MAX - XP_MIN + 1));
}

export function canEarnXp(lastXpAt, now) {
  return lastXpAt == null || now - lastXpAt >= XP_COOLDOWN_MS;
}
