import { describe, expect, it } from "vitest";
import { createInMemoryStorage, createYoutubeDataApiSourceResolver, createYoutubeLearningSdk } from "../../src/index.js";

describe("createYoutubeDataApiSourceResolver", () => {
  it("resolves a single video using a fake fetch", async () => {
    const fetch = createFakeFetch([
      {
        items: [
          {
            id: "abc123",
            etag: "etag-video",
            snippet: {
              title: "Video title",
              description: "Video description",
              channelId: "channel-1",
              channelTitle: "Channel",
              publishedAt: "2026-01-01T00:00:00Z",
            },
            contentDetails: { duration: "PT1H2M3S" },
            status: { privacyStatus: "public" },
          },
        ],
      },
    ]);
    const resolver = createYoutubeDataApiSourceResolver({ apiKey: "test-key", fetch });

    const result = await resolver.resolve(
      { type: "video", url: "https://www.youtube.com/watch?v=abc123" },
      { storage: createInMemoryStorage(), reportProgress: async () => {} },
    );

    expect(result.videos).toEqual([
      expect.objectContaining({
        id: "abc123",
        title: "Video title",
        durationSeconds: 3723,
        availability: "available",
        etag: "etag-video",
      }),
    ]);
    expect(fetch.urls[0]?.pathname).toBe("/youtube/v3/videos");
  });

  it("resolves paginated playlists, dedupes duplicates, and represents unavailable videos", async () => {
    const progress: unknown[] = [];
    const fetch = createFakeFetch([
      {
        nextPageToken: "page-2",
        items: [
          { snippet: { title: "A", position: 0, resourceId: { videoId: "a" } } },
          { snippet: { title: "Deleted video", position: 1, resourceId: { videoId: "deleted" } } },
        ],
      },
      {
        items: [
          { snippet: { title: "A duplicate", position: 2, resourceId: { videoId: "a" } } },
          { snippet: { title: "B", position: 3, resourceId: { videoId: "b" } } },
        ],
      },
      {
        items: [
          {
            id: "a",
            snippet: { title: "A", channelId: "c", channelTitle: "Channel", publishedAt: "2026-01-01T00:00:00Z" },
            contentDetails: { duration: "PT10M" },
            status: { privacyStatus: "public" },
          },
          {
            id: "b",
            snippet: { title: "B", channelId: "c", channelTitle: "Channel", publishedAt: "2026-01-02T00:00:00Z" },
            contentDetails: { duration: "PT20M" },
            status: { privacyStatus: "public" },
          },
        ],
      },
    ]);
    const resolver = createYoutubeDataApiSourceResolver({ apiKey: "test-key", fetch });

    const result = await resolver.resolve(
      { type: "playlist", url: "https://www.youtube.com/playlist?list=PL123" },
      {
        storage: createInMemoryStorage(),
        reportProgress: async (event) => {
          progress.push(event.data);
        },
      },
    );

    expect(result.videos.map((video) => [video.id, video.position, video.availability])).toEqual([
      ["a", 0, "available"],
      ["deleted", 1, "deleted"],
      ["b", 3, "available"],
    ]);
    expect(progress).toContainEqual({ page: 1, itemCount: 2, hasNextPage: true });
    expect(progress).toContainEqual({ page: 2, itemCount: 4, hasNextPage: false });
    expect(progress).toContainEqual(expect.objectContaining({ videoCount: 3, duplicateCount: 1, unavailableCount: 1 }));
  });

  it("uses cached source resolution on repeated calls", async () => {
    const storage = createInMemoryStorage();
    const progress: string[] = [];
    const fetch = createFakeFetch([{ items: [{ id: "abc123", status: { privacyStatus: "public" } }] }]);
    const resolver = createYoutubeDataApiSourceResolver({ apiKey: "test-key", fetch, now: () => 1_000 });
    const context = {
      storage,
      reportProgress: async (event: { status: string }) => {
        progress.push(event.status);
      },
    };

    await resolver.resolve({ type: "video", url: "https://www.youtube.com/watch?v=abc123" }, context);
    await resolver.resolve({ type: "video", url: "https://www.youtube.com/watch?v=abc123" }, context);

    expect(fetch.urls).toHaveLength(1);
    expect(progress).toContain("skipped");
  });

  it("refetches source resolution after cache TTL expires", async () => {
    let now = 1_000;
    const storage = createInMemoryStorage();
    const fetch = createFakeFetch([
      { items: [{ id: "abc123", snippet: { title: "Old" }, status: { privacyStatus: "public" } }] },
      { items: [{ id: "abc123", snippet: { title: "New" }, status: { privacyStatus: "public" } }] },
    ]);
    const resolver = createYoutubeDataApiSourceResolver({ apiKey: "test-key", cacheTtlMs: 100, fetch, now: () => now });
    const context = { storage, reportProgress: async () => {} };

    const first = await resolver.resolve({ type: "video", url: "https://www.youtube.com/watch?v=abc123" }, context);
    now = 1_200;
    const second = await resolver.resolve({ type: "video", url: "https://www.youtube.com/watch?v=abc123" }, context);

    expect(fetch.urls).toHaveLength(2);
    expect(first.videos[0]?.title).toBe("Old");
    expect(second.videos[0]?.title).toBe("New");
  });

  it("bypasses a fresh cache entry when forceRefresh is enabled", async () => {
    const storage = createInMemoryStorage();
    const fetch = createFakeFetch([
      { items: [{ id: "abc123", snippet: { title: "Old" }, status: { privacyStatus: "public" } }] },
      { items: [{ id: "abc123", snippet: { title: "Forced" }, status: { privacyStatus: "public" } }] },
    ]);
    const source = { type: "video" as const, url: "https://www.youtube.com/watch?v=abc123" };

    await createYoutubeDataApiSourceResolver({ apiKey: "test-key", fetch, now: () => 1_000 }).resolve(source, {
      storage,
      reportProgress: async () => {},
    });
    const refreshed = await createYoutubeDataApiSourceResolver({ apiKey: "test-key", fetch, forceRefresh: true, now: () => 1_010 }).resolve(source, {
      storage,
      reportProgress: async () => {},
    });

    expect(fetch.urls).toHaveLength(2);
    expect(refreshed.videos[0]?.title).toBe("Forced");
  });

  it("throws when maxPages truncates a playlist unless partial resolution is allowed", async () => {
    const progress: unknown[] = [];
    const fetch = createFakeFetch([
      {
        nextPageToken: "page-2",
        items: [{ snippet: { title: "A", position: 0, resourceId: { videoId: "a" } } }],
      },
    ]);
    const resolver = createYoutubeDataApiSourceResolver({ apiKey: "test-key", fetch, maxPages: 1 });

    await expect(
      resolver.resolve(
        { type: "playlist", url: "https://www.youtube.com/playlist?list=PL123" },
        {
          storage: createInMemoryStorage(),
          reportProgress: async (event) => progress.push(event.data),
        },
      ),
    ).rejects.toMatchObject({ code: "RESOLUTION_FAILED" });
    expect(progress).toContainEqual({ maxPages: 1, nextPageToken: "page-2", pageCount: 1, partialItemCount: 1 });
  });

  it("marks sdk.process partial when partial playlist resolution is explicitly allowed", async () => {
    const fetch = createFakeFetch([
      {
        nextPageToken: "page-2",
        items: [{ snippet: { title: "A", position: 0, resourceId: { videoId: "a" } } }],
      },
      {
        items: [{ id: "a", snippet: { title: "A" }, contentDetails: { duration: "PT10M" }, status: { privacyStatus: "public" } }],
      },
    ]);
    const sdk = createYoutubeLearningSdk({
      storage: createInMemoryStorage(),
      sourceResolver: createYoutubeDataApiSourceResolver({ apiKey: "test-key", allowPartial: true, fetch, maxPages: 1 }),
    });

    const result = await sdk.process({ source: { type: "playlist", url: "https://www.youtube.com/playlist?list=PL123" } });

    expect(result.status).toBe("partial");
    expect(result.sourceResolution).toMatchObject({ nextPageToken: "page-2", pageCount: 1, truncated: true });
    expect(result.videos.map((video) => video.id)).toEqual(["a"]);
  });
});

function createFakeFetch(payloads: unknown[]) {
  const urls: URL[] = [];
  const fetch = (async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(input.toString());
    urls.push(url);
    const payload = payloads.shift();
    if (!payload) {
      throw new Error(`Unexpected fetch call: ${url.toString()}`);
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch & { urls: URL[] };
  fetch.urls = urls;
  return fetch;
}
