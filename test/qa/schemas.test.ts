import { describe, expect, it } from "vitest";
import { answerSchema } from "../../src/index.js";

describe("answerSchema", () => {
  it("accepts answered responses with citations", () => {
    expect(answerSchema.parse({
      answer: "Answer",
      status: "answered",
      citations: [{ videoId: "video-1", startSeconds: 1, endSeconds: 2, chunkId: "chunk-1" }],
      replayRanges: [{ videoId: "video-1", startSeconds: 1, endSeconds: 2 }],
      followUpQuestions: ["Next?"],
      confidence: { score: 0.9, reason: "Grounded" },
    })).toBeTruthy();
  });

  it("rejects answered responses without citations", () => {
    expect(() => answerSchema.parse({
      answer: "Answer",
      status: "answered",
      citations: [],
      replayRanges: [],
      followUpQuestions: [],
      confidence: { score: 0.9, reason: "No citations" },
    })).toThrow();
  });

  it("accepts insufficient-context responses without citations", () => {
    expect(answerSchema.parse({
      answer: "I do not have enough context.",
      status: "insufficient_context",
      citations: [],
      replayRanges: [],
      followUpQuestions: [],
      confidence: { score: 0, reason: "No context" },
    })).toBeTruthy();
  });
});
