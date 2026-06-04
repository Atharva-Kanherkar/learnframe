import { describe, expect, it } from "vitest";
import {
  chunkNotesSchema,
  flashcardsSchema,
  glossarySchema,
  playlistSyllabusSchema,
  prerequisiteMapSchema,
  quizSchema,
  studyPlanSchema,
  videoSummarySchema,
} from "../../src/index.js";

const citation = { videoId: "video-1", startSeconds: 0, endSeconds: 10, chunkId: "chunk-1" };

describe("artifact schemas", () => {
  it("accept valid payloads", () => {
    expect(chunkNotesSchema.parse({ chunkId: "chunk-1", videoId: "video-1", summary: "Summary", keyPoints: ["Point"], concepts: ["Concept"], citations: [citation] })).toBeTruthy();
    expect(videoSummarySchema.parse({ videoId: "video-1", summary: "Summary", keyPoints: ["Point"], citations: [citation] })).toBeTruthy();
    expect(playlistSyllabusSchema.parse({ courseId: "course-1", title: "Course", modules: [{ title: "Module", summary: "Summary", videoIds: ["video-1"], outcomes: ["Outcome"] }] })).toBeTruthy();
    expect(glossarySchema.parse({ terms: [{ term: "Term", definition: "Definition", citations: [citation] }] })).toBeTruthy();
    expect(quizSchema.parse({ questions: [{ question: "Q?", choices: ["A", "B"], answer: "A", explanation: "Because", citations: [citation] }] })).toBeTruthy();
    expect(flashcardsSchema.parse({ cards: [{ front: "Front", back: "Back", citations: [citation] }] })).toBeTruthy();
    expect(studyPlanSchema.parse({ courseId: "course-1", steps: [{ title: "Step", objective: "Objective", videoIds: ["video-1"] }] })).toBeTruthy();
    expect(prerequisiteMapSchema.parse({ prerequisites: [{ concept: "Advanced", requiredBefore: ["Basics"], reason: "Order matters", citations: [citation] }] })).toBeTruthy();
  });

  it("rejects invalid payloads", () => {
    expect(() => chunkNotesSchema.parse({ chunkId: "chunk-1", videoId: "video-1", summary: "", keyPoints: [], concepts: [], citations: [] })).toThrow();
    expect(() => chunkNotesSchema.parse({ chunkId: "chunk-1", videoId: "video-1", summary: "Summary", keyPoints: ["Point"], concepts: ["Concept"], citations: [{ videoId: "video-1", startSeconds: 10, endSeconds: 1 }] })).toThrow();
    expect(() => quizSchema.parse({ questions: [{ question: "Q?", choices: ["A"], answer: "A", explanation: "Because", citations: [] }] })).toThrow();
  });
});
