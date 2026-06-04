import { describe, expect, it } from "vitest";
import { createInMemoryStorage, getOrComputeCached } from "../../src/index.js";

describe("getOrComputeCached", () => {
  it("computes and stores on miss, then skips compute on hit", async () => {
    const storage = createInMemoryStorage();
    let calls = 0;

    const first = await getOrComputeCached(storage, "key", () => {
      calls += 1;
      return { value: 1 };
    });
    const second = await getOrComputeCached(storage, "key", () => {
      calls += 1;
      return { value: 2 };
    });

    expect(first).toEqual({ value: { value: 1 }, cacheHit: false });
    expect(second).toEqual({ value: { value: 1 }, cacheHit: true });
    expect(calls).toBe(1);
  });
});
