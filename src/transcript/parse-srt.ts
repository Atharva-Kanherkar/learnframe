import { LearnFrameError } from "../contracts.js";
import { parseCaptionTimestamp } from "./time.js";
import type { TranscriptCue } from "./parse-vtt.js";

export function parseSrt(input: string): TranscriptCue[] {
  const normalized = input.replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n{2,}/u);
  const cues: TranscriptCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length === 0) {
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

function parseTimingLine(line: string): Pick<TranscriptCue, "startSeconds" | "endSeconds"> {
  const [start, end] = line.split(/\s+-->\s+/u);
  if (!start || !end) {
    throw new LearnFrameError("RESOLUTION_FAILED", `Invalid SRT timing line: ${line}`);
  }

  return {
    startSeconds: parseCaptionTimestamp(start),
    endSeconds: parseCaptionTimestamp(end),
  };
}
