/** mulberry32: PRNG có seed, đủ cho test sinh tập ngẫu nhiên lặp lại được (in seed khi test đỏ). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const randomSubset = <T>(items: readonly T[], rnd: () => number): T[] =>
  items.filter(() => rnd() < 0.5);
