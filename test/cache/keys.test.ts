import { describe, expect, it } from "vitest";
import {
  createArtifactCacheKey,
  createChunkCacheKey,
  createEmbeddingCacheKey,
  createInputHash,
  createPipelineCacheKey,
} from "../../src/index.js";

describe("cache key helpers", () => {
  it("creates stable chunk cache keys and changes when chunk options change", () => {
    const left = createChunkCacheKey({ transcriptHash: "t1", chunkerVersion: "v1", options: { maxTokens: 100, overlapSegments: 1 } });
    const right = createChunkCacheKey({ transcriptHash: "t1", chunkerVersion: "v1", options: { overlapSegments: 1, maxTokens: 100 } });
    const changed = createChunkCacheKey({ transcriptHash: "t1", chunkerVersion: "v1", options: { maxTokens: 200, overlapSegments: 1 } });

    expect(left).toBe(right);
    expect(left).not.toBe(changed);
  });

  it("creates pipeline cache keys with namespace, task, model, prompt version, input hash, and options", () => {
    expect(createPipelineCacheKey({
      namespace: "artifact",
      task: "summary",
      model: "cheap-model",
      promptVersion: "summary-v1",
      inputHash: "input-hash",
      options: { temperature: 0, schema: "summary" },
    })).toBe('pipeline:artifact:summary:cheap-model:summary-v1:input-hash:{"schema":"summary","temperature":0}');
  });

  it("creates embedding and artifact cache keys", () => {
    expect(createEmbeddingCacheKey({ model: "embed-model", inputHash: "chunk-hash", options: { dimensions: 512 } }))
      .toContain("pipeline:embedding:embed:embed-model:none:chunk-hash");
    expect(createArtifactCacheKey({ task: "quiz", model: "medium", promptVersion: "quiz-v1", inputHash: "notes-hash" }))
      .toBe("pipeline:artifact:quiz:medium:quiz-v1:notes-hash:{}");
  });

  it("hashes structurally equivalent inputs deterministically", () => {
    expect(createInputHash({ b: 2, a: 1 })).toBe(createInputHash({ a: 1, b: 2 }));
  });
});
