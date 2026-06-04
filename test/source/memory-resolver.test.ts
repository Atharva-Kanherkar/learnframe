import { describe, expect, it } from "vitest";
import { createInMemorySourceResolver, createInMemoryStorage, createYoutubeLearningSdk } from "../../src/index.js";

describe("createInMemorySourceResolver", () => {
  it("resolves a video as a playlist of one", async () => {
    const resolver = createInMemorySourceResolver();
    const result = await resolver.resolve(
      { type: "video", url: "https://www.youtube.com/watch?v=abc123" },
      {
        storage: createInMemoryStorage(),
        reportProgress: async () => {},
      },
    );

    expect(result.videos).toHaveLength(1);
    expect(result.playlist.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({ id: "abc123", position: 0, availability: "available" });
  });

  it("resolves fixture playlist videos in order with dedupe and unavailable statuses", async () => {
    const progress: unknown[] = [];
    const resolver = createInMemorySourceResolver({
      playlists: {
        PL123: {
          id: "PL123",
          url: "https://www.youtube.com/playlist?list=PL123",
          title: "Fixture playlist",
          videos: [
            { id: "a", url: "https://www.youtube.com/watch?v=a", position: 0, availability: "available" },
            { id: "b", url: "https://www.youtube.com/watch?v=b", position: 1, availability: "unavailable" },
            { id: "a", url: "https://www.youtube.com/watch?v=a", position: 2, availability: "available" },
          ],
        },
      },
    });

    const result = await resolver.resolve(
      { type: "playlist", url: "https://www.youtube.com/playlist?list=PL123" },
      {
        storage: createInMemoryStorage(),
        reportProgress: async (event) => {
          progress.push(event.data);
        },
      },
    );

    expect(result.playlist.title).toBe("Fixture playlist");
    expect(result.videos.map((video) => video.id)).toEqual(["a", "b"]);
    expect(result.videos[1]?.availability).toBe("unavailable");
    expect(progress).toContainEqual({ videoCount: 2, duplicateCount: 1, unavailableCount: 1 });
  });

  it("sdk.process returns ordered playlist metadata and progress", async () => {
    const progress: string[] = [];
    const sdk = createYoutubeLearningSdk({
      storage: createInMemoryStorage(),
      sourceResolver: createInMemorySourceResolver({
        playlists: {
          PL123: {
            id: "PL123",
            url: "https://www.youtube.com/playlist?list=PL123",
            videos: [
              { id: "first", url: "https://www.youtube.com/watch?v=first", position: 0, availability: "available" },
              { id: "second", url: "https://www.youtube.com/watch?v=second", position: 1, availability: "available" },
            ],
          },
        },
      }),
    });

    const result = await sdk.process({
      source: { type: "playlist", url: "https://www.youtube.com/playlist?list=PL123" },
      onProgress: (event) => progress.push(`${event.stage}:${event.status}`),
    });

    expect(result.videos.map((video) => video.id)).toEqual(["first", "second"]);
    expect(progress).toContain("source_resolution:started");
    expect(progress).toContain("source_resolution:completed");
  });
});
