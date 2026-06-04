import { describe, expect, it } from "vitest";
import { createTranscriptCacheKey } from "../../src/index.js";

describe("createTranscriptCacheKey", () => {
  it("returns stable keys and changes for transcript dimensions", () => {
    const base = {
      provider: "yt-dlp",
      videoId: "video-1",
      language: "en",
      captionKind: "human" as const,
      sourceHash: "hash-1",
      parserVersion: "v1",
      options: { normalize: true, fallbackLanguages: ["es", "fr"] },
    };

    expect(createTranscriptCacheKey(base)).toBe(createTranscriptCacheKey({ ...base, options: { fallbackLanguages: ["es", "fr"], normalize: true } }));
    expect(createTranscriptCacheKey(base)).not.toBe(createTranscriptCacheKey({ ...base, language: "es" }));
    expect(createTranscriptCacheKey(base)).not.toBe(createTranscriptCacheKey({ ...base, captionKind: "auto" }));
    expect(createTranscriptCacheKey(base)).not.toBe(createTranscriptCacheKey({ ...base, sourceHash: "hash-2" }));
  });
});
