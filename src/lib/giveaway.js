// Elige hasta `count` ganadores distintos al azar (Fisher-Yates parcial).
export function pickWinners(entries, count, rng = Math.random) {
  const pool = [...entries];
  const total = Math.min(count, pool.length);
  for (let i = 0; i < total; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, total);
}
