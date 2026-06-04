import type { Artifact, AskAtTimestampInput, AskResponse, EmbeddingsAdapter, LlmAdapter, LlmRequest, RetrievalQaEngine, TranscriptChunk } from "../contracts.js";
import { answerSchema } from "./schemas.js";

export type ChunkEmbeddingIndex = Record<string, number[]>;

export type RetrievalQaEngineOptions = {
  chunks: TranscriptChunk[];
  llm: LlmAdapter;
  artifacts?: Artifact[];
  embeddings?: EmbeddingsAdapter;
  chunkEmbeddings?: ChunkEmbeddingIndex;
  maxContextChunks?: number;
  nearbyWindowSeconds?: number;
  semanticTopK?: number;
};

type RankedChunk = {
  chunk: TranscriptChunk;
  source: "nearby" | "semantic" | "video" | "playlist";
  score: number;
};

export function createRetrievalQaEngine(options: RetrievalQaEngineOptions): RetrievalQaEngine {
  const maxContextChunks = options.maxContextChunks ?? 6;
  const nearbyWindowSeconds = options.nearbyWindowSeconds ?? 120;
  const semanticTopK = options.semanticTopK ?? maxContextChunks;

  return {
    async ask(input) {
      const nearby = getNearbyChunks(options.chunks, input, nearbyWindowSeconds);
      const semantic = await getSemanticChunks(options, input, semanticTopK);
      const fallback = getFallbackChunks(options.chunks, input);
      const selectedChunks = dedupeRankedChunks([...nearby, ...semantic, ...fallback]).slice(0, maxContextChunks);
      const summaryContext = getCompressedArtifactContext(options.artifacts ?? [], input);

      if (selectedChunks.length === 0 && summaryContext.length === 0) {
        return insufficientContext("No transcript chunks or compressed course context were available.");
      }

      const request: LlmRequest = {
        task: "retrieval-qa-answer",
        promptVersion: "retrieval-qa-v1",
        modelRole: "medium",
        input: {
          question: input.question,
          courseId: input.courseId,
          videoId: input.videoId,
          timestampSeconds: input.timestampSeconds,
          selectedText: input.selectedText,
          contextChunks: selectedChunks.map(({ chunk, source, score }) => ({
            id: chunk.id,
            videoId: chunk.videoId,
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
            text: chunk.text,
            source,
            score,
          })),
          courseContext: summaryContext,
          instructions: "Answer only from provided context. If context is insufficient, return insufficient_context. Answered responses must cite timestamp ranges.",
        },
      };

      try {
        return answerSchema.parse(await options.llm.generateStructured<AskResponse>(request));
      } catch (error) {
        return insufficientContext(error instanceof Error ? error.message : "Answer did not satisfy citation schema.");
      }
    },
  };
}

function getNearbyChunks(chunks: TranscriptChunk[], input: AskAtTimestampInput, windowSeconds: number): RankedChunk[] {
  if (!input.videoId || input.timestampSeconds === undefined) {
    return [];
  }

  return chunks
    .filter((chunk) => chunk.videoId === input.videoId)
    .map((chunk) => ({ chunk, distance: distanceToChunk(chunk, input.timestampSeconds ?? 0) }))
    .filter(({ distance }) => distance <= windowSeconds)
    .sort((left, right) => left.distance - right.distance || left.chunk.startSeconds - right.chunk.startSeconds)
    .map(({ chunk, distance }) => ({ chunk, source: "nearby", score: 1 / (1 + distance) }));
}

async function getSemanticChunks(
  options: RetrievalQaEngineOptions,
  input: AskAtTimestampInput,
  topK: number,
): Promise<RankedChunk[]> {
  if (!options.embeddings || !options.chunkEmbeddings || topK <= 0) {
    return [];
  }

  const [queryEmbedding] = await options.embeddings.embed([input.question]);
  if (!queryEmbedding) {
    return [];
  }

  return options.chunks
    .filter((chunk) => !input.videoId || chunk.videoId === input.videoId)
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, options.chunkEmbeddings?.[chunk.id] ?? []) }))
    .filter(({ score }) => Number.isFinite(score) && score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map(({ chunk, score }) => ({ chunk, source: "semantic", score }));
}

function getFallbackChunks(chunks: TranscriptChunk[], input: AskAtTimestampInput): RankedChunk[] {
  return chunks
    .filter((chunk) => !input.videoId || chunk.videoId === input.videoId)
    .map((chunk, index) => ({ chunk, source: input.videoId ? "video" : "playlist", score: 0.01 - index / 100_000 }));
}

function dedupeRankedChunks(chunks: RankedChunk[]): RankedChunk[] {
  const seen = new Set<string>();
  const deduped: RankedChunk[] = [];
  for (const ranked of chunks) {
    if (seen.has(ranked.chunk.id)) {
      continue;
    }
    seen.add(ranked.chunk.id);
    deduped.push(ranked);
  }
  return deduped;
}

function getCompressedArtifactContext(artifacts: Artifact[], input: AskAtTimestampInput): Array<Pick<Artifact, "kind" | "videoId" | "data">> {
  return artifacts
    .filter((artifact) => artifact.courseId === input.courseId)
    .filter((artifact) => artifact.kind === "summary" || artifact.kind === "syllabus")
    .filter((artifact) => !input.videoId || !artifact.videoId || artifact.videoId === input.videoId)
    .map((artifact) => ({ kind: artifact.kind, videoId: artifact.videoId, data: artifact.data }));
}

function distanceToChunk(chunk: TranscriptChunk, timestampSeconds: number): number {
  if (timestampSeconds >= chunk.startSeconds && timestampSeconds <= chunk.endSeconds) {
    return 0;
  }
  return Math.min(Math.abs(timestampSeconds - chunk.startSeconds), Math.abs(timestampSeconds - chunk.endSeconds));
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function insufficientContext(reason: string): AskResponse {
  return {
    answer: "I do not have enough context to answer that from the available transcript and course artifacts.",
    status: "insufficient_context",
    citations: [],
    replayRanges: [],
    followUpQuestions: [],
    confidence: { score: 0, reason },
  };
}
