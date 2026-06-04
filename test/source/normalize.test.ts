import { describe, expect, it } from "vitest";
import { dedupeVideoMetadata, normalizeResolvedYoutubeSource } from "../../src/index.js";
import type { VideoMetadata } from "../../src/index.js";

describe("dedupeVideoMetadata", () => {
  it("preserves first occurrence order and reports duplicate count", () => {
    const videos: VideoMetadata[] = [
      { id: "a", url: "https://www.youtube.com/watch?v=a", position: 0, availability: "available" },
      { id: "b", url: "https://www.youtube.com/watch?v=b", position: 1, availability: "available" },
      { id: "a", url: "https://www.youtube.com/watch?v=a", position: 2, availability: "available" },
    ];

    expect(dedupeVideoMetadata(videos)).toEqual({
      duplicateCount: 1,
      videos: [videos[0], videos[1]],
    });
  });
});

describe("normalizeResolvedYoutubeSource", () => {
  it("preserves playlist order and unavailable video statuses", () => {
    const normalized = normalizeResolvedYoutubeSource({
      source: { type: "playlist", url: "https://www.youtube.com/playlist?list=PL123" },
      playlist: { id: "PL123", url: "https://www.youtube.com/playlist?list=PL123" },
      videos: [
        { id: "available", url: "https://www.youtube.com/watch?v=available", position: 0, availability: "available" },
        { id: "deleted", url: "https://www.youtube.com/watch?v=deleted", position: 1, availability: "deleted" },
        { id: "private", url: "https://www.youtube.com/watch?v=private", position: 2, availability: "private" },
      ],
    });

    expect(normalized.videos.map((video) => video.id)).toEqual(["available", "deleted", "private"]);
    expect(normalized.unavailableCount).toBe(2);
    expect(normalized.duplicateCount).toBe(0);
    expect(normalized.playlist.videos[1]?.availability).toBe("deleted");
  });
});
