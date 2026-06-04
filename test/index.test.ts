import { describe, expect, it } from "vitest";
import {
  LearnFrameError,
  createInMemorySourceResolver,
  createInMemoryStorage,
  createLearnFrame,
  createYoutubeLearningSdk,
  sourceSchema,
} from "../src/index.js";

describe("sourceSchema", () => {
  it("accepts valid YouTube video source shape", () => {
    const result = sourceSchema.safeParse({
      type: "video",
      url: "https://www.youtube.com/watch?v=abc123",
      language: "en",
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid video URLs", () => {
    const result = sourceSchema.safeParse({
      type: "video",
      url: "not-a-url",
    });

    expect(result.success).toBe(false);
  });

  it("accepts valid playlist source shape and rejects invalid source types", () => {
    expect(
      sourceSchema.safeParse({
        type: "playlist",
        url: "https://www.youtube.com/playlist?list=PL123",
        playlistId: "PL123",
      }).success,
    ).toBe(true);

    expect(
      sourceSchema.safeParse({
        type: "channel",
        url: "https://www.youtube.com/@example",
      }).success,
    ).toBe(false);
  });
});

describe("createYoutubeLearningSdk", () => {
  it("can be instantiated with in-memory adapters from the package root", async () => {
    const storage = createInMemoryStorage();
    const sdk = createYoutubeLearningSdk({
      sourceResolver: createInMemorySourceResolver(),
      storage,
    });

    expect(sdk).toEqual({
      process: expect.any(Function),
      ask: expect.any(Function),
    });
    expect(createLearnFrame).toBe(createYoutubeLearningSdk);
  });

  it("treats a video input as a playlist of one and emits progress", async () => {
    const progress: string[] = [];
    const sdk = createYoutubeLearningSdk({
      sourceResolver: createInMemorySourceResolver(),
      storage: createInMemoryStorage(),
    });

    const result = await sdk.process({
      source: { type: "video", url: "https://www.youtube.com/watch?v=abc123" },
      onProgress: (event) => progress.push(`${event.stage}:${event.status}`),
    });

    expect(result.courseId).toBe("youtube-course:playlist:https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc123");
    expect(result.videos).toHaveLength(1);
    expect(result.playlist.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({
      id: "abc123",
      availability: "available",
      position: 0,
    });
    expect(progress).toContain("validation:started");
    expect(progress).toContain("validation:completed");
    expect(progress).toContain("source_resolution:started");
    expect(progress).toContain("source_resolution:completed");
    expect(progress).toContain("completed:completed");
  });

  it("throws a typed error for invalid source input", async () => {
    const sdk = createYoutubeLearningSdk({
      sourceResolver: createInMemorySourceResolver(),
      storage: createInMemoryStorage(),
    });

    await expect(
      sdk.process({ source: { type: "video", url: "invalid" } }),
    ).rejects.toMatchObject({
      name: "LearnFrameError",
      code: "INVALID_SOURCE",
    } satisfies Partial<LearnFrameError>);
  });

  it("returns insufficient context from ask before retrieval QA is implemented", async () => {
    const sdk = createLearnFrame({
      sourceResolver: createInMemorySourceResolver(),
      storage: createInMemoryStorage(),
    });

    const answer = await sdk.ask({
      courseId: "youtube-course:abc123",
      videoId: "abc123",
      timestampSeconds: 612,
      question: "What is happening here?",
    });

    expect(answer).toMatchObject({
      status: "insufficient_context",
      citations: [],
      replayRanges: [],
      confidence: { score: 0 },
    });
  });
});

describe("InMemoryStorageAdapter", () => {
  it("stores, retrieves, deletes, and reports cache hits deterministically", async () => {
    const storage = createInMemoryStorage();

    expect(await storage.has("key")).toBe(false);
    expect(await storage.get<{ value: number }>("key")).toBeUndefined();

    await storage.set("key", { value: 1 });

    expect(await storage.has("key")).toBe(true);
    expect(await storage.get<{ value: number }>("key")).toEqual({ value: 1 });

    await storage.delete("key");

    expect(await storage.has("key")).toBe(false);
    expect(await storage.get("key")).toBeUndefined();
  });
});
