import type { CaptionKind } from "../contracts.js";
import { stableStringify } from "../source/keys.js";

export type TranscriptCacheKeyInput = {
  provider: string;
  videoId: string;
  language: string;
  captionKind: CaptionKind;
  sourceHash: string;
  parserVersion: string;
  options?: Record<string, unknown>;
};

export function createTranscriptCacheKey(input: TranscriptCacheKeyInput): string {
  return [
    "transcript",
    input.provider,
    input.videoId,
    input.language,
    input.captionKind,
    input.sourceHash,
    input.parserVersion,
    stableStringify(input.options ?? {}),
  ].join(":");
}
