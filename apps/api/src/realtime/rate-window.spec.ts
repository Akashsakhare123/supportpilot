import { withinRate } from './rate-window';

describe('withinRate', () => {
  it('allows up to the limit per window, then frees slots as time passes', () => {
    const times: number[] = [];
    expect(withinRate(times, 2, 1_000, 0)).toBe(true);
    expect(withinRate(times, 2, 1_000, 100)).toBe(true);
    expect(withinRate(times, 2, 1_000, 200)).toBe(false);
    expect(withinRate(times, 2, 1_000, 1_000)).toBe(true);
    expect(times).toEqual([100, 1_000]);
  });
});
