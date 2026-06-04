import { describe, expect, it } from "vitest";
import {
  YtDlpTranscriptProvider,
  buildExtractSubtitleArgs,
  createInMemoryStorage,
  parseYtDlpSubtitleList,
  selectCaptionTrack,
} from "../../src/index.js";
import type { VideoMetadata, YtDlpRunner } from "../../src/index.js";

const video: VideoMetadata = {
  id: "video-1",
  url: "https://www.youtube.com/watch?v=video-1",
  availability: "available",
};

describe("YtDlpTranscriptProvider", () => {
  it("chooses requested human captions before auto captions", async () => {
    const runner = createFakeRunner([
      { stdout: subtitleList(), stderr: "" },
      { stdout: "", stderr: "", files: { "video-1.en.vtt": vtt("Human caption") } },
    ]);
    const provider = new YtDlpTranscriptProvider({ now: () => new Date("2026-01-01T00:00:00Z"), runner });

    const transcript = await provider.getTranscript(video, { language: "en" });

    expect(transcript.status).toBe("available");
    expect(transcript.provenance).toMatchObject({ captionKind: "human", language: "en", provider: "yt-dlp" });
    expect(transcript.segments[0]?.text).toBe("Human caption");
    expect(runner.calls[1]).toEqual(expect.arrayContaining(["--skip-download", "--write-sub", "--sub-lang", "en"]));
    expect(runner.calls[1]).not.toContain("--extract-audio");
  });

  it("falls back to English and configured fallback languages", () => {
    const tracks = parseYtDlpSubtitleList(subtitleList());

    expect(selectCaptionTrack(tracks, { language: "de" }, ["es"])).toMatchObject({ language: "en", captionKind: "human" });
    expect(selectCaptionTrack(tracks.filter((track) => track.language !== "en"), { language: "de" }, ["es"])).toMatchObject({
      language: "es",
      captionKind: "auto",
    });
  });

  it("returns missing when captions are absent and paid transcription is disabled", async () => {
    const provider = new YtDlpTranscriptProvider({ runner: createFakeRunner([{ stdout: "", stderr: "" }]) });

    await expect(provider.getTranscript(video, { allowPaidTranscription: false })).resolves.toMatchObject({
      videoId: "video-1",
      status: "missing",
      segments: [],
    });
  });

  it("returns needs_transcription when captions are absent and paid transcription is enabled", async () => {
    const provider = new YtDlpTranscriptProvider({ runner: createFakeRunner([{ stdout: "", stderr: "" }]) });

    await expect(provider.getTranscript(video, { allowPaidTranscription: true })).resolves.toMatchObject({
      status: "needs_transcription",
      segments: [],
    });
  });

  it("returns blocked for provider-reported blocked failures", async () => {
    const provider = new YtDlpTranscriptProvider({
      runner: createFakeRunner([{ error: new Error("This video is private") }]),
    });

    await expect(provider.getTranscript(video)).resolves.toMatchObject({ status: "blocked", segments: [] });
  });

  it("uses cached transcripts when the selected track cache matches", async () => {
    const runner = createFakeRunner([
      { stdout: subtitleList(), stderr: "" },
      { stdout: "", stderr: "", files: { "video-1.en.vtt": vtt("Cached caption") } },
      { stdout: subtitleList(), stderr: "" },
    ]);
    const provider = new YtDlpTranscriptProvider({ runner, storage: createInMemoryStorage() });

    const first = await provider.getTranscript(video, { language: "en" });
    const second = await provider.getTranscript(video, { language: "en" });

    expect(first.segments).toEqual(second.segments);
    expect(runner.calls.filter((args) => args.includes("--write-sub"))).toHaveLength(1);
  });
});

describe("yt-dlp transcript helpers", () => {
  it("parses full subtitle format lists that contain spaces", () => {
    const tracks = parseYtDlpSubtitleList(`[info] Available subtitles for video-1:
Language Name Formats
en English vtt, ttml, srv3, srv2, srv1, json3`);

    expect(tracks).toEqual([
      {
        language: "en",
        captionKind: "human",
        formats: ["vtt", "ttml", "srv3", "srv2", "srv1", "json3"],
      },
    ]);
    expect(selectCaptionTrack(tracks, { language: "en" }, [])).toMatchObject({ format: "vtt" });
  });

  it("builds extraction args with skip-download and subtitle-only flags", () => {
    expect(buildExtractSubtitleArgs("https://example.test", { language: "en", captionKind: "human", formats: ["vtt"], format: "vtt" }, "/tmp/out"))
      .toEqual(expect.arrayContaining(["--ignore-config", "--skip-download", "--write-sub", "--sub-lang", "en", "--sub-format", "vtt"]));
  });
});

function createFakeRunner(results: Array<{ stdout?: string; stderr?: string; files?: Record<string, string>; error?: Error }>): YtDlpRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      const result = results.shift();
      if (!result) {
        throw new Error(`Unexpected yt-dlp call: ${args.join(" ")}`);
      }
      if (result.error) {
        throw result.error;
      }
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", files: result.files };
    },
  };
}

function subtitleList(): string {
  return `[info] Available subtitles for video-1:
Language Name Formats
en English vtt, srt
[info] Available automatic captions for video-1:
Language Name Formats
en English vtt
es Spanish vtt`;
}

function vtt(text: string): string {
  return `WEBVTT

00:00:01.000 --> 00:00:02.000
${text}
`;
}
