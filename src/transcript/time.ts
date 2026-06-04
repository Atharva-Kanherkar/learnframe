import { LearnFrameError } from "../contracts.js";

export function parseCaptionTimestamp(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new LearnFrameError("RESOLUTION_FAILED", `Invalid caption timestamp: ${value}`);
  }

  const secondsPart = parts.at(-1);
  const minutesPart = parts.at(-2);
  const hoursPart = parts.length === 3 ? parts[0] : "0";
  if (!secondsPart || !minutesPart || hoursPart === undefined) {
    throw new LearnFrameError("RESOLUTION_FAILED", `Invalid caption timestamp: ${value}`);
  }

  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);
  const seconds = Number(secondsPart);
  if (![hours, minutes, seconds].every(Number.isFinite)) {
    throw new LearnFrameError("RESOLUTION_FAILED", `Invalid caption timestamp: ${value}`);
  }

  return hours * 3600 + minutes * 60 + seconds;
}
