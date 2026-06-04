import type { StorageAdapter } from "../contracts.js";

export type CachedComputeResult<T> = {
  value: T;
  cacheHit: boolean;
};

export async function getOrComputeCached<T>(
  storage: StorageAdapter,
  key: string,
  compute: () => Promise<T> | T,
): Promise<CachedComputeResult<T>> {
  const cached = await storage.get<T>(key);
  if (cached !== undefined) {
    return { value: cached, cacheHit: true };
  }

  const value = await compute();
  await storage.set(key, value);
  return { value, cacheHit: false };
}
