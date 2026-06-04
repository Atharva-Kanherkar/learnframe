import { describe, expect, it } from "vitest";
import { createInMemoryStorage, createLowCostArtifactEngine } from "../../src/index.js";
import type { LlmAdapter, LlmRequest, TranscriptChunk } from "../../src/index.js";

describe("createLowCostArtifactEngine", () => {
  it("generates chunk notes with metadata and timestamp citations", async () => {
    const llm = createFakeLlm();
    const engine = createLowCostArtifactEngine({ llm, storage: createInMemoryStorage() });

    const artifacts = await engine.generate({ courseId: "course-1", chunks: [chunk("chunk-1", "video-1", 0, 10)], outputs: ["notes"] });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ kind: "notes", promptVersion: "chunk-notes-v1", modelRole: "cheap", videoId: "video-1" });
    expect(artifacts[0]?.cacheKey).toContain("pipeline:artifact:chunk-notes:cheap:chunk-notes-v1");
    expect(artifacts[0]?.data).toMatchObject({ citations: [{ videoId: "video-1", startSeconds: 0, endSeconds: 10, chunkId: "chunk-1" }] });
  });

  it("synthesizes video summaries from chunk notes, not raw transcript chunks", async () => {
    const llm = createFakeLlm();
    const engine = createLowCostArtifactEngine({ llm, storage: createInMemoryStorage() });

    await engine.generate({ courseId: "course-1", chunks: [chunk("chunk-1", "video-1", 0, 10)], outputs: ["summary"] });

    const summaryCall = llm.calls.find((call) => call.task === "video-summary");
    expect(summaryCall?.input).toHaveProperty("chunkNotes");
    expect(JSON.stringify(summaryCall?.input)).not.toContain("Raw transcript text");
  });

  it("uses compressed video summaries for playlist syllabus", async () => {
    const llm = createFakeLlm();
    const engine = createLowCostArtifactEngine({ llm, storage: createInMemoryStorage() });

    const artifacts = await engine.generate({ courseId: "course-1", chunks: [chunk("chunk-1", "video-1", 0, 10)], outputs: ["syllabus"] });

    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["syllabus"]);
    const syllabusCall = llm.calls.find((call) => call.task === "playlist-syllabus");
    expect(syllabusCall?.input).toHaveProperty("videoSummaries");
    expect(syllabusCall?.input).not.toHaveProperty("chunks");
  });

  it("generates only requested outputs", async () => {
    const llm = createFakeLlm();
    const engine = createLowCostArtifactEngine({ llm, storage: createInMemoryStorage() });

    const artifacts = await engine.generate({ courseId: "course-1", chunks: [chunk("chunk-1", "video-1", 0, 10)], outputs: ["quiz"] });

    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["quiz"]);
    expect(llm.calls.map((call) => call.task)).toEqual(["chunk-notes", "quiz"]);
  });

  it("cache hits skip duplicate LLM calls", async () => {
    const llm = createFakeLlm();
    const storage = createInMemoryStorage();
    const engine = createLowCostArtifactEngine({ llm, storage });
    const input = { courseId: "course-1", chunks: [chunk("chunk-1", "video-1", 0, 10)], outputs: ["notes" as const] };

    await engine.generate(input);
    await engine.generate(input);

    expect(llm.calls).toHaveLength(1);
  });

  it("supports glossary, flashcards, study plan, and prerequisite map operations", async () => {
    const llm = createFakeLlm();
    const engine = createLowCostArtifactEngine({ llm, storage: createInMemoryStorage() });

    const artifacts = await engine.generate({
      courseId: "course-1",
      chunks: [chunk("chunk-1", "video-1", 0, 10)],
      outputs: ["glossary", "flashcards", "study_plan", "prerequisite_map"],
    });

    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["glossary", "flashcards", "study_plan", "prerequisite_map"]);
  });
});

function chunk(id: string, videoId: string, startSeconds: number, endSeconds: number): TranscriptChunk {
  return { id, videoId, startSeconds, endSeconds, text: "Raw transcript text", sourceSegmentIds: [`${id}:segment`], tokenEstimate: 10 };
}

function createFakeLlm(): LlmAdapter & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async generateStructured(request) {
      calls.push(request);
      const citation = { videoId: "video-1", startSeconds: 0, endSeconds: 10, chunkId: "chunk-1" };
      switch (request.task) {
        case "chunk-notes":
          return { chunkId: "chunk-1", videoId: "video-1", summary: "Chunk summary", keyPoints: ["Point"], concepts: ["Concept"], citations: [citation] };
        case "video-summary":
          return { videoId: "video-1", summary: "Video summary", keyPoints: ["Point"], citations: [citation] };
        case "playlist-syllabus":
          return { courseId: "course-1", title: "Course", modules: [{ title: "Module", summary: "Summary", videoIds: ["video-1"], outcomes: ["Outcome"] }] };
        case "glossary":
          return { terms: [{ term: "Term", definition: "Definition", citations: [citation] }] };
        case "quiz":
          return { questions: [{ question: "Q?", choices: ["A", "B"], answer: "A", explanation: "Because", citations: [citation] }] };
        case "flashcards":
          return { cards: [{ front: "Front", back: "Back", citations: [citation] }] };
        case "study-plan":
          return { courseId: "course-1", steps: [{ title: "Step", objective: "Objective", videoIds: ["video-1"] }] };
        case "prerequisite-map":
          return { prerequisites: [{ concept: "Advanced", requiredBefore: ["Basics"], reason: "Order matters", citations: [citation] }] };
        default:
          throw new Error(`Unhandled task ${request.task}`);
      }
    },
  };
}
