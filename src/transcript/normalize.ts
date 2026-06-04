import { createHash } from "node:crypto";
import type { CaptionKind, TranscriptSegment } from "../contracts.js";
import type { TranscriptCue } from "./parse-vtt.js";

export type NormalizeTranscriptCuesInput = {
  videoId: string;
  language: string;
  captionKind: CaptionKind;
  cues: TranscriptCue[];
};

export function normalizeTranscriptCues(input: NormalizeTranscriptCuesInput): TranscriptSegment[] {
  return input.cues
    .map((cue, index) => ({
      id: `${input.videoId}:caption:${input.language}:${input.captionKind}:${index}`,
      videoId: input.videoId,
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
      text: cleanCaptionText(cue.text),
    }))
    .filter((segment) => segment.text.length > 0);
}

export function cleanCaptionText(input: string): string {
  return input
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}>/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&nbsp;/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function createTranscriptSourceHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
