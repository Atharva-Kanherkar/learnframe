import { describe, expect, it } from "vitest";
import { chunkTranscript, estimateTokens } from "../../src/index.js";
import type { Transcript, TranscriptSegment } from "../../src/index.js";

describe("estimateTokens", () => {
  it("returns deterministic positive estimates for non-empty text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hey")).toBe(1);
    expect(estimateTokens("a".repeat(9))).toBe(3);
  });
});

describe("chunkTranscript", () => {
  it("preserves timestamps and source segment IDs", () => {
    const chunks = chunkTranscript(transcript([segment("s1", 0, 2, "aaaa"), segment("s2", 2, 4, "bbbb")]), {
      maxTokens: 10,
      estimateTokens: () => 2,
    });

    expect(chunks).toEqual([
      {
        id: "video-1:chunk:0",
        videoId: "video-1",
        startSeconds: 0,
        endSeconds: 4,
        text: "aaaa\nbbbb",
        sourceSegmentIds: ["s1", "s2"],
        tokenEstimate: 4,
      },
    ]);
  });

  it("respects token budget for normal segment groups", () => {
    const chunks = chunkTranscript(transcript([segment("s1", 0, 1, "one"), segment("s2", 1, 2, "two"), segment("s3", 2, 3, "three")]), {
      maxTokens: 2,
      estimateTokens: () => 1,
    });

    expect(chunks.map((chunk) => chunk.sourceSegmentIds)).toEqual([["s1", "s2"], ["s3"]]);
  });

  it("keeps oversized single segments intact", () => {
    const chunks = chunkTranscript(transcript([segment("large", 0, 10, "x".repeat(100))]), {
      maxTokens: 5,
      estimateTokens: () => 20,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sourceSegmentIds).toEqual(["large"]);
    expect(chunks[0]?.tokenEstimate).toBe(20);
  });

  it("keeps oversized segments intact even when overlap is enabled", () => {
    const chunks = chunkTranscript(transcript([segment("intro", 0, 1, "intro"), segment("large", 1, 10, "x".repeat(100))]), {
      maxTokens: 5,
      overlapSegments: 1,
      estimateTokens: (text) => (text.startsWith("x") ? 20 : 1),
    });

    expect(chunks.map((chunk) => chunk.sourceSegmentIds)).toEqual([["intro"], ["large"]]);
    expect(chunks[1]?.tokenEstimate).toBe(20);
  });

  it("applies configurable segment overlap deterministically", () => {
    const chunks = chunkTranscript(transcript([segment("s1", 0, 1, "one"), segment("s2", 1, 2, "two"), segment("s3", 2, 3, "three")]), {
      maxTokens: 2,
      overlapSegments: 1,
      estimateTokens: () => 1,
    });

    expect(chunks.map((chunk) => chunk.sourceSegmentIds)).toEqual([["s1", "s2"], ["s2", "s3"]]);
  });

  it("ignores empty transcript segments", () => {
    const chunks = chunkTranscript(transcript([segment("empty", 0, 1, "   "), segment("s1", 1, 2, "text")]), {
      maxTokens: 10,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sourceSegmentIds).toEqual(["s1"]);
  });
});

function transcript(segments: TranscriptSegment[]): Transcript {
  return {
    videoId: "video-1",
    status: "available",
    segments,
  };
}

function segment(id: string, startSeconds: number, endSeconds: number, text: string): TranscriptSegment {
  return { id, videoId: "video-1", startSeconds, endSeconds, text };
}
