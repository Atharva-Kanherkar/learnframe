import type { Transcript, TranscriptChunk, TranscriptSegment } from "../contracts.js";

export type ChunkTranscriptOptions = {
  maxTokens?: number;
  overlapSegments?: number;
  estimateTokens?: (text: string) => number;
};

export const DEFAULT_CHUNK_MAX_TOKENS = 800;

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function chunkTranscript(transcript: Transcript, options: ChunkTranscriptOptions = {}): TranscriptChunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_CHUNK_MAX_TOKENS;
  const overlapSegments = Math.max(0, options.overlapSegments ?? 0);
  const tokenEstimator = options.estimateTokens ?? estimateTokens;
  const segments = transcript.segments.filter((segment) => segment.text.trim().length > 0);
  const chunks: TranscriptChunk[] = [];
  let current: TranscriptSegment[] = [];
  let currentTokens = 0;

  for (const segment of segments) {
    const segmentTokens = tokenEstimator(segment.text);
    if (current.length > 0 && currentTokens + segmentTokens > maxTokens) {
      chunks.push(createChunk(transcript.videoId, chunks.length, current, tokenEstimator));
      current = overlapSegments > 0 ? current.slice(-overlapSegments) : [];
      currentTokens = sumTokens(current, tokenEstimator);
    }

    current.push(segment);
    currentTokens += segmentTokens;

    if (segmentTokens > maxTokens && current.length === 1) {
      chunks.push(createChunk(transcript.videoId, chunks.length, current, tokenEstimator));
      current = [];
      currentTokens = 0;
    }
  }

  if (current.length > 0) {
    chunks.push(createChunk(transcript.videoId, chunks.length, current, tokenEstimator));
  }

  return chunks;
}

function createChunk(
  videoId: string,
  index: number,
  segments: TranscriptSegment[],
  tokenEstimator: (text: string) => number,
): TranscriptChunk {
  const first = segments[0];
  const last = segments.at(-1);
  if (!first || !last) {
    throw new Error("Cannot create a transcript chunk without segments");
  }

  return {
    id: `${videoId}:chunk:${index}`,
    videoId,
    startSeconds: first.startSeconds,
    endSeconds: last.endSeconds,
    text: segments.map((segment) => segment.text.trim()).join("\n"),
    sourceSegmentIds: segments.map((segment) => segment.id),
    tokenEstimate: sumTokens(segments, tokenEstimator),
  };
}

function sumTokens(segments: TranscriptSegment[], tokenEstimator: (text: string) => number): number {
  return segments.reduce((total, segment) => total + tokenEstimator(segment.text), 0);
}
