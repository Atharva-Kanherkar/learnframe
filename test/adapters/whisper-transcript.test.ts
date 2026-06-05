import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WhisperTranscriptProvider,
  buildExtractAudioArgs,
  createInMemoryStorage,
} from "../../src/index.js";
import type { YtDlpRunner } from "../../src/index.js";

const OPENAI_WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

describe("WhisperTranscriptProvider", () => {
  it("extracts audio with --extract-audio and no video flags", () => {
    const args = buildExtractAudioArgs("https://www.youtube.com/watch?v=abc123", "/tmp/out");

    expect(args).toContain("--extract-audio");
    expect(args).toContain("--audio-format");
    expect(args).toContain("mp3");
    expect(args).toContain("--audio-quality");
    expect(args).toContain("9");
    expect(args).toContain("--ignore-config");
    expect(args).toContain("--no-playlist");
    expect(args).not.toContain("--write-sub");
    expect(args).not.toContain("--write-video");
  });

  it("posts audio to the OpenAI Whisper endpoint", async () => {
    let postedUrl = "";
    let postedModel = "";
    const fetch = createFakeFetch((url, init) => {
      postedUrl = url;
      postedModel = extractFormField(init?.body as FormData, "model") ?? "";
      return new Response(JSON.stringify(whisperResponse(["Hello world"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new WhisperTranscriptProvider({
      apiKey: "test-key",
      fetch,
      runner: createFakeRunner(),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const transcript = await provider.getTranscript(
      { id: "abc123", url: "https://www.youtube.com/watch?v=abc123", availability: "available" },
    );

    expect(postedUrl).toBe(OPENAI_WHISPER_URL);
    expect(postedModel).toBe("whisper-1");
    expect(transcript.segments[0]?.text).toBe("Hello world");
  });

  it("normalizes Whisper response segments to TranscriptSegment[]", async () => {
    const fetch = createFakeFetch(() => new Response(JSON.stringify(whisperResponse(["First", "Second"])), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const provider = new WhisperTranscriptProvider({
      apiKey: "test-key",
      fetch,
      runner: createFakeRunner(),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const transcript = await provider.getTranscript(
      { id: "abc123", url: "https://www.youtube.com/watch?v=abc123", availability: "available" },
    );

    expect(transcript.segments).toHaveLength(2);
    expect(transcript.segments.map((segment) => segment.text)).toEqual(["First", "Second"]);
    expect(transcript.segments[0]).toMatchObject({
      videoId: "abc123",
      startSeconds: 0,
      endSeconds: 1,
      id: "abc123:caption:en:transcribed:0",
    });
    expect(transcript.segments[1]).toMatchObject({
      startSeconds: 1,
      endSeconds: 2,
      id: "abc123:caption:en:transcribed:1",
    });
  });

  it("fills provenance with transcribed kind and openai-whisper provider", async () => {
    const fetch = createFakeFetch(() => new Response(JSON.stringify(whisperResponse(["Text"], "fr")), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const provider = new WhisperTranscriptProvider({
      apiKey: "test-key",
      fetch,
      runner: createFakeRunner(),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const transcript = await provider.getTranscript(
      { id: "abc123", url: "https://www.youtube.com/watch?v=abc123", availability: "available" },
    );

    expect(transcript.provenance).toMatchObject({
      provider: "openai-whisper",
      language: "fr",
      captionKind: "transcribed",
    });
    expect(transcript.provenance?.extractedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("caches repeated transcript requests", async () => {
    let callCount = 0;
    const fetch = createFakeFetch(() => {
      callCount += 1;
      return new Response(JSON.stringify(whisperResponse(["Cached"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new WhisperTranscriptProvider({
      apiKey: "test-key",
      fetch,
      runner: createFakeRunner(),
      storage: createInMemoryStorage(),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    await provider.getTranscript({ id: "abc123", url: "https://www.youtube.com/watch?v=abc123", availability: "available" });
    await provider.getTranscript({ id: "abc123", url: "https://www.youtube.com/watch?v=abc123", availability: "available" });

    expect(callCount).toBe(1);
  });

  it("returns blocked for private/unavailable yt-dlp errors", async () => {
    const provider = new WhisperTranscriptProvider({
      apiKey: "test-key",
      runner: createFakeRunner(new Error("This video is private")),
    });

    const transcript = await provider.getTranscript(
      { id: "abc123", url: "https://www.youtube.com/watch?v=abc123", availability: "available" },
    );

    expect(transcript).toMatchObject({ status: "blocked", segments: [] });
  });
});

function whisperResponse(texts: string[], language = "en"): unknown {
  return {
    text: texts.join(" "),
    language,
    segments: texts.map((text, index) => ({
      id: index,
      start: index,
      end: index + 1,
      text,
      confidence: 0.9,
    })),
  };
}

function createFakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof globalThis.fetch {
  return ((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const result = handler(url, init);
    if (result instanceof Response) {
      return result;
    }
    throw new Error(`Unexpected handler return: ${String(result)}`);
  }) as typeof globalThis.fetch);
}

function createFakeRunner(error?: Error): YtDlpRunner {
  return {
    async run(args, options) {
      if (error) {
        throw error;
      }
      if (options.cwd) {
        const videoId = args.find((arg, index) => args[index - 1] === "--output" || args[index - 1] === "-o")?.match(/%\(id\)s/) ? "abc123" : "abc123";
        await writeFile(join(options.cwd, `${videoId}.mp3`), Buffer.from([0xFF, 0xFB, 0x90, 0x00]));
      }
      return { stdout: "", stderr: "" };
    },
  };
}

function extractFormField(form: FormData, key: string): string | undefined {
  try {
    return form.get(key)?.toString();
  } catch {
    return undefined;
  }
}
