import { LearnFrameError } from "../contracts.js";
import { parseCaptionTimestamp } from "./time.js";

export type TranscriptCue = {
  id?: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export function parseVtt(input: string): TranscriptCue[] {
  const normalized = input.replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.trimStart().startsWith("WEBVTT")) {
    throw new LearnFrameError("RESOLUTION_FAILED", "Invalid VTT: missing WEBVTT header");
  }

  const blocks = normalized.split(/\n{2,}/u).slice(1);
  const cues: TranscriptCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length === 0 || isVttMetadataBlock(lines[0])) {
      continue;
    }

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) {
      continue;
    }

    const id = timingIndex > 0 ? lines.slice(0, timingIndex).join(" ").trim() : undefined;
    const timing = parseTimingLine(lines[timingIndex]);
    const text = lines.slice(timingIndex + 1).join("\n").trim();
    if (text) {
      cues.push({ id, ...timing, text });
    }
  }

  return cues;
}

function isVttMetadataBlock(firstLine: string): boolean {
  return firstLine.startsWith("NOTE") || firstLine === "STYLE" || firstLine === "REGION";
}

function parseTimingLine(line: string): Pick<TranscriptCue, "startSeconds" | "endSeconds"> {
  const [start, rest] = line.split(/\s+-->\s+/u);
  const end = rest?.split(/\s+/u)[0];
  if (!start || !end) {
    throw new LearnFrameError("RESOLUTION_FAILED", `Invalid VTT timing line: ${line}`);
  }

  return {
    startSeconds: parseCaptionTimestamp(start),
    endSeconds: parseCaptionTimestamp(end),
  };
}
