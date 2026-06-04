import { createHash } from "node:crypto";
import { stableStringify } from "../source/keys.js";

export type PipelineCacheKeyInput = {
  namespace: string;
  task: string;
  inputHash: string;
  model?: string;
  promptVersion?: string;
  options?: Record<string, unknown>;
};

export type ChunkCacheKeyInput = {
  transcriptHash: string;
  chunkerVersion: string;
  options?: Record<string, unknown>;
};

export type EmbeddingCacheKeyInput = {
  model: string;
  inputHash: string;
  options?: Record<string, unknown>;
};

export type ArtifactCacheKeyInput = {
  task: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  options?: Record<string, unknown>;
};

export function createPipelineCacheKey(input: PipelineCacheKeyInput): string {
  return [
    "pipeline",
    input.namespace,
    input.task,
    input.model ?? "none",
    input.promptVersion ?? "none",
    input.inputHash,
    stableStringify(input.options ?? {}),
  ].join(":");
}

export function createChunkCacheKey(input: ChunkCacheKeyInput): string {
  return createPipelineCacheKey({
    namespace: "chunk",
    task: "chunk-transcript",
    inputHash: input.transcriptHash,
    promptVersion: input.chunkerVersion,
    options: input.options,
  });
}

export function createEmbeddingCacheKey(input: EmbeddingCacheKeyInput): string {
  return createPipelineCacheKey({
    namespace: "embedding",
    task: "embed",
    model: input.model,
    inputHash: input.inputHash,
    options: input.options,
  });
}

export function createArtifactCacheKey(input: ArtifactCacheKeyInput): string {
  return createPipelineCacheKey({
    namespace: "artifact",
    task: input.task,
    model: input.model,
    promptVersion: input.promptVersion,
    inputHash: input.inputHash,
    options: input.options,
  });
}

export function createInputHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
