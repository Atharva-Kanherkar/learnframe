import { describe, expect, it } from "vitest";
import { createLearnFrame, createRetrievalQaEngine } from "../../src/index.js";
import type { Artifact, EmbeddingsAdapter, LlmAdapter, LlmRequest, SourceResolver, StorageAdapter, TranscriptChunk } from "../../src/index.js";

describe("createRetrievalQaEngine", () => {
  it("ranks timestamp-nearby chunks before semantic matches", async () => {
    const llm = createAnsweringLlm();
    const engine = createRetrievalQaEngine({
      chunks: [chunk("near", "video-1", 100, 120), chunk("semantic", "video-1", 900, 920)],
      chunkEmbeddings: { near: [0, 1], semantic: [1, 0] },
      embeddings: fakeEmbeddings([1, 0]),
      llm,
      maxContextChunks: 2,
    });

    await engine.ask({ courseId: "course-1", videoId: "video-1", timestampSeconds: 110, question: "explain" });

    expect(llm.lastInput()?.contextChunks.map((item: { id: string }) => item.id)).toEqual(["near", "semantic"]);
  });

  it("supports video-only and playlist-wide questions", async () => {
    const llm = createAnsweringLlm();
    const engine = createRetrievalQaEngine({
      chunks: [chunk("v1", "video-1", 0, 10), chunk("v2", "video-2", 0, 10)],
      llm,
    });

    await engine.ask({ courseId: "course-1", videoId: "video-1", question: "video question" });
    expect(llm.lastInput()?.contextChunks.map((item: { id: string }) => item.id)).toEqual(["v1"]);

    await engine.ask({ courseId: "course-1", question: "playlist question" });
    expect(llm.lastInput()?.contextChunks.map((item: { id: string }) => item.id)).toEqual(["v1", "v2"]);
  });

  it("keeps context bounded by maxContextChunks", async () => {
    const llm = createAnsweringLlm();
    const engine = createRetrievalQaEngine({
      chunks: [chunk("a", "video-1", 0, 1), chunk("b", "video-1", 2, 3), chunk("c", "video-1", 4, 5)],
      llm,
      maxContextChunks: 2,
    });

    await engine.ask({ courseId: "course-1", videoId: "video-1", question: "bounded" });

    expect(llm.lastInput()?.contextChunks).toHaveLength(2);
  });

  it("includes compressed summary and syllabus artifacts, not raw transcript text", async () => {
    const llm = createAnsweringLlm();
    const engine = createRetrievalQaEngine({
      chunks: [chunk("a", "video-1", 0, 1)],
      artifacts: [summaryArtifact(), syllabusArtifact(), notesArtifact()],
      llm,
    });

    await engine.ask({ courseId: "course-1", question: "course context" });

    expect(llm.lastInput()?.courseContext.map((item: { kind: string }) => item.kind)).toEqual(["summary", "syllabus"]);
    expect(JSON.stringify(llm.lastInput())).not.toContain("raw full transcript");
  });

  it("returns insufficient_context when no chunks or summary context exist", async () => {
    const llm = createAnsweringLlm();
    const engine = createRetrievalQaEngine({ chunks: [], llm });

    const answer = await engine.ask({ courseId: "course-1", question: "unknown" });

    expect(answer.status).toBe("insufficient_context");
    expect(llm.calls).toHaveLength(0);
  });

  it("returns insufficient_context when LLM answer lacks required citations", async () => {
    const engine = createRetrievalQaEngine({ chunks: [chunk("a", "video-1", 0, 1)], llm: createUncitedLlm() });

    const answer = await engine.ask({ courseId: "course-1", question: "bad answer" });

    expect(answer.status).toBe("insufficient_context");
  });
});

describe("sdk ask integration", () => {
  it("delegates to configured QA engine after validation", async () => {
    const sdk = createLearnFrame({
      qa: { ask: async () => ({ answer: "Delegated", status: "answered", citations: [{ videoId: "video-1", startSeconds: 0, endSeconds: 1 }], replayRanges: [], followUpQuestions: [], confidence: { score: 1, reason: "test" } }) },
      sourceResolver: fakeSourceResolver(),
      storage: fakeStorage(),
    });

    await expect(sdk.ask({ courseId: "course-1", question: "hi" })).resolves.toMatchObject({ answer: "Delegated" });
  });
});

function chunk(id: string, videoId: string, startSeconds: number, endSeconds: number): TranscriptChunk {
  return { id, videoId, startSeconds, endSeconds, text: `${id} text`, sourceSegmentIds: [`${id}:segment`], tokenEstimate: 5 };
}

function createAnsweringLlm(): LlmAdapter & { calls: LlmRequest[]; lastInput(): any } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    lastInput: () => calls.at(-1)?.input as any,
    async generateStructured(request) {
      calls.push(request);
      const context = (request.input as { contextChunks: Array<{ id: string; videoId: string; startSeconds: number; endSeconds: number }> }).contextChunks;
      const first = context[0];
      return {
        answer: "Grounded answer",
        status: "answered",
        citations: first ? [{ videoId: first.videoId, startSeconds: first.startSeconds, endSeconds: first.endSeconds, chunkId: first.id }] : [],
        replayRanges: first ? [{ videoId: first.videoId, startSeconds: first.startSeconds, endSeconds: first.endSeconds }] : [],
        followUpQuestions: ["Follow up?"],
        confidence: { score: 0.8, reason: "Grounded in context" },
      };
    },
  };
}

function createUncitedLlm(): LlmAdapter {
  return {
    async generateStructured() {
      return { answer: "Uncited", status: "answered", citations: [], replayRanges: [], followUpQuestions: [], confidence: { score: 0.5, reason: "No citations" } };
    },
  };
}

function fakeEmbeddings(vector: number[]): EmbeddingsAdapter {
  return { embed: async () => [vector] };
}

function summaryArtifact(): Artifact {
  return { id: "summary", kind: "summary", courseId: "course-1", videoId: "video-1", data: { summary: "compressed summary" } };
}

function syllabusArtifact(): Artifact {
  return { id: "syllabus", kind: "syllabus", courseId: "course-1", data: { title: "syllabus" } };
}

function notesArtifact(): Artifact {
  return { id: "notes", kind: "notes", courseId: "course-1", data: { text: "raw full transcript should not be used" } };
}

function fakeSourceResolver(): SourceResolver {
  return { resolve: async () => { throw new Error("not used"); } };
}

function fakeStorage(): StorageAdapter {
  return { get: async () => undefined, set: async () => {}, delete: async () => {}, has: async () => false };
}
