import { describe, expect, it } from "vitest";
import { LearnFrameError, createSourceResolutionCacheKey, parseYoutubeUrl } from "../../src/index.js";

describe("parseYoutubeUrl", () => {
  it("parses canonical watch URLs", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/watch?v=abc123")).toMatchObject({
      kind: "video",
      videoId: "abc123",
      canonicalUrl: "https://www.youtube.com/watch?v=abc123",
    });
  });

  it("parses youtu.be URLs", () => {
    expect(parseYoutubeUrl("https://youtu.be/abc123?t=42")).toMatchObject({
      kind: "video",
      videoId: "abc123",
      canonicalUrl: "https://www.youtube.com/watch?v=abc123",
    });
  });

  it("parses shorts URLs", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/shorts/short123")).toMatchObject({
      kind: "video",
      videoId: "short123",
      canonicalUrl: "https://www.youtube.com/watch?v=short123",
    });
  });

  it("parses playlist URLs", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/playlist?list=PL123")).toMatchObject({
      kind: "playlist",
      playlistId: "PL123",
      canonicalUrl: "https://www.youtube.com/playlist?list=PL123",
    });
  });

  it("parses mixed watch-plus-playlist URLs and captures both IDs", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/watch?v=abc123&list=PL123")).toMatchObject({
      kind: "videoWithPlaylist",
      videoId: "abc123",
      playlistId: "PL123",
      canonicalUrl: "https://www.youtube.com/watch?v=abc123&list=PL123",
    });
  });

  it("accepts music.youtube.com with a warning", () => {
    const parsed = parseYoutubeUrl("https://music.youtube.com/watch?v=abc123");

    expect(parsed.videoId).toBe("abc123");
    expect(parsed.warnings).toEqual(["music.youtube.com URLs are treated as YouTube URLs for source resolution."]);
  });

  it("rejects non-YouTube URLs", () => {
    expect(() => parseYoutubeUrl("https://example.com/watch?v=abc123")).toThrow(LearnFrameError);
  });
});

describe("createSourceResolutionCacheKey", () => {
  it("returns the same key for equivalent inputs", () => {
    const parsed = parseYoutubeUrl("https://www.youtube.com/watch?v=abc123");
    const left = createSourceResolutionCacheKey({
      provider: "fixture",
      source: { type: "video", url: "https://www.youtube.com/watch?v=abc123" },
      parsed,
      options: { fields: ["title", "duration"], maxPages: 2 },
    });
    const right = createSourceResolutionCacheKey({
      provider: "fixture",
      source: { type: "video", url: "https://www.youtube.com/watch?v=abc123" },
      parsed,
      options: { maxPages: 2, fields: ["title", "duration"] },
    });

    expect(left).toBe(right);
  });

  it("changes when provider or options change", () => {
    const parsed = parseYoutubeUrl("https://www.youtube.com/watch?v=abc123");
    const base = {
      source: { type: "video" as const, url: "https://www.youtube.com/watch?v=abc123" },
      parsed,
    };

    expect(createSourceResolutionCacheKey({ ...base, provider: "fixture", options: { maxPages: 1 } })).not.toBe(
      createSourceResolutionCacheKey({ ...base, provider: "youtube-data-api", options: { maxPages: 1 } }),
    );
    expect(createSourceResolutionCacheKey({ ...base, provider: "fixture", options: { maxPages: 1 } })).not.toBe(
      createSourceResolutionCacheKey({ ...base, provider: "fixture", options: { maxPages: 2 } }),
    );
  });
});
