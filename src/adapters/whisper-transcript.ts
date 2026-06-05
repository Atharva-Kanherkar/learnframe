import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  StorageAdapter,
  Transcript,
  TranscriptProvider,
  TranscriptRequest,
  VideoMetadata,
} from "../contracts.js";
import { LearnFrameError } from "../contracts.js";
import { createTranscriptCacheKey } from "../transcript/keys.js";
import { createTranscriptSourceHash, normalizeTranscriptCues } from "../transcript/normalize.js";
import type { TranscriptCue } from "../transcript/parse-vtt.js";
import type { YtDlpRunner } from "./yt-dlp-transcript.js";

const execFileAsync = promisify(execFile);

export type WhisperTranscriptProviderOptions = {
  apiKey: string;
  binaryPath?: string;
  model?: string;
  language?: string;
  now?: () => Date;
  runner?: YtDlpRunner;
  storage?: StorageAdapter;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};



type WhisperSegment = {
  id: number;
  start: number;
  end: number;
  text: string;
  confidence?: number;
};

type WhisperResponse = {
  text: string;
  language?: string;
  segments?: WhisperSegment[];
};

export class WhisperTranscriptProvider implements TranscriptProvider {
  private readonly apiKey: string;
  private readonly binaryPath: string;
  private readonly model: string;
  private readonly requestedLanguage: string | undefined;
  private readonly now: () => Date;
  private readonly runner: YtDlpRunner;
  private readonly storage?: StorageAdapter;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: WhisperTranscriptProviderOptions) {
    this.apiKey = options.apiKey;
    this.binaryPath = options.binaryPath ?? "yt-dlp";
    this.model = options.model ?? "whisper-1";
    this.requestedLanguage = options.language;
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? createDefaultYtDlpRunner(this.binaryPath);
    this.storage = options.storage;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async getTranscript(video: VideoMetadata, request: TranscriptRequest = {}): Promise<Transcript> {
    const language = request.language ?? this.requestedLanguage;
    const sourceHash = `whisper:${video.id}:${language ?? "auto"}:${this.model}`;
    const cacheKey = createTranscriptCacheKey({
      provider: "openai-whisper",
      videoId: video.id,
      language: language ?? "auto",
      captionKind: "transcribed",
      sourceHash,
      parserVersion: "v1",
      options: { model: this.model },
    });

    if (this.storage) {
      const cached = await this.storage.get<Transcript>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    let audioPath: string;
    let tempDir: string;
    try {
      tempDir = await mkdtemp(join(tmpdir(), "learnframe-whisper-"));
      await this.runner.run(buildExtractAudioArgs(video.url, tempDir), { cwd: tempDir, timeoutMs: this.timeoutMs });
      const files = await readdir(tempDir);
      const audioFile = files.find((file) => file.endsWith(".mp3") || file.endsWith(".m4a") || file.endsWith(".wav") || file.endsWith(".webm"));
      if (!audioFile) {
        throw new LearnFrameError("RESOLUTION_FAILED", "yt-dlp did not produce an audio file");
      }
      audioPath = join(tempDir, audioFile);
    } catch (error) {
      await rm(tempDir!, { force: true, recursive: true }).catch(() => {});
      if (isBlockedYtDlpError(error)) {
        return { videoId: video.id, status: "blocked", segments: [] };
      }
      throw error instanceof Error ? error : new LearnFrameError("RESOLUTION_FAILED", String(error));
    }

    let response: WhisperResponse;
    try {
      const raw = await transcribe(this.fetchImpl, this.apiKey, this.model, language, audioPath);
      response = JSON.parse(raw) as WhisperResponse;
    } catch (error) {
      await rm(tempDir, { force: true, recursive: true }).catch(() => {});
      if (error instanceof LearnFrameError) {
        throw error;
      }
      throw new LearnFrameError("RESOLUTION_FAILED", `Whisper transcription failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await rm(tempDir, { force: true, recursive: true });
    } catch {
      // best-effort cleanup
    }

    const cues: TranscriptCue[] = (response.segments ?? []).map((segment) => ({
      id: String(segment.id),
      startSeconds: segment.start,
      endSeconds: segment.end,
      text: segment.text,
    }));

    const detectedLanguage = response.language ?? language ?? "auto";
    const rawHash = createTranscriptSourceHash(JSON.stringify(response.segments ?? []));
    const transcript: Transcript = {
      videoId: video.id,
      status: "available",
      provenance: {
        provider: "openai-whisper",
        language: detectedLanguage,
        captionKind: "transcribed",
        sourceHash: rawHash,
        extractedAt: this.now().toISOString(),
      },
      segments: normalizeTranscriptCues({
        videoId: video.id,
        language: detectedLanguage,
        captionKind: "transcribed",
        cues,
      }),
    };

    if (this.storage) {
      await this.storage.set(cacheKey, transcript);
    }
    return transcript;
  }
}

export function buildExtractAudioArgs(url: string, outputDir: string): string[] {
  return [
    "--ignore-config",
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--no-playlist",
    "--no-warnings",
    "--output",
    `${join(outputDir, "%(id)s.%(ext)s")}`,
    url,
  ];
}

async function transcribe(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  model: string,
  language: string | undefined,
  audioPath: string,
): Promise<string> {
  const form = new FormData();
  form.set("model", model);
  form.set("response_format", "verbose_json");
  if (language) {
    form.set("language", language);
  }

  const audioBuffer = await readFile(audioPath);
  const audioBlob = new Blob([audioBuffer], { type: "audio/mp3" });
  form.set("file", audioBlob, `${model}.mp3`);

  const response = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LearnFrameError("RESOLUTION_FAILED", `OpenAI Whisper request failed with ${response.status}: ${body}`);
  }

  return response.text();
}

function createDefaultYtDlpRunner(binaryPath: string): YtDlpRunner {
  return {
    async run(args, options) {
      try {
        const { stdout, stderr } = await execFileAsync(binaryPath, args, {
          cwd: options.cwd,
          encoding: "utf8",
          maxBuffer: 50 * 1024 * 1024,
          shell: false,
          timeout: options.timeoutMs,
          windowsHide: true,
        });
        return { stdout, stderr };
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  };
}

function isBlockedYtDlpError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return ["private", "unavailable", "age", "geo", "copyright", "blocked"].some((needle) => message.includes(needle));
}
