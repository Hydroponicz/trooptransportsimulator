/**
 * Circles (towns, yards...) bucketed in a 250 m grid: is (x, z) within r + m of
 * one? m may be up to `pad`. `test` replaces the round test (it must stay within r + pad).
 */
export function circleIndex<T extends { x: number; z: number; r: number }>(items: T[], pad: number, test?: (o: T, x: number, z: number, m: number) => boolean) {
  const G = 250;
  const grid = new Map<number, T[]>();
  for (const o of items) {
    const R = o.r + pad;
    for (let cx = Math.floor((o.x - R) / G); cx <= Math.floor((o.x + R) / G); cx++)
      for (let cz = Math.floor((o.z - R) / G); cz <= Math.floor((o.z + R) / G); cz++) {
        const k = cx + 1000 + (cz + 1000) * 3000;
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(o);
      }
  }
  return (x: number, z: number, m: number) => {
    const arr = grid.get(Math.floor(x / G) + 1000 + (Math.floor(z / G) + 1000) * 3000);
    if (!arr) return false;
    for (const o of arr) if (test ? test(o, x, z, m) : Math.hypot(o.x - x, o.z - z) < o.r + m) return true;
    return false;
  };
}
