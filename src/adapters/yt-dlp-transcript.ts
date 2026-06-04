import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  CaptionKind,
  StorageAdapter,
  Transcript,
  TranscriptProvider,
  TranscriptRequest,
  VideoMetadata,
} from "../contracts.js";
import { LearnFrameError } from "../contracts.js";
import { createTranscriptCacheKey } from "../transcript/keys.js";
import { createTranscriptSourceHash, normalizeTranscriptCues } from "../transcript/normalize.js";
import { parseSrt } from "../transcript/parse-srt.js";
import { parseVtt } from "../transcript/parse-vtt.js";

const execFileAsync = promisify(execFile);
const PARSER_VERSION = "v1";

export type YtDlpCaptionTrack = {
  language: string;
  captionKind: Exclude<CaptionKind, "transcribed">;
  formats: string[];
};

export type YtDlpRunResult = {
  stdout: string;
  stderr: string;
  files?: Record<string, string>;
};

export type YtDlpRunnerOptions = {
  cwd?: string;
  timeoutMs: number;
};

export type YtDlpRunner = {
  run(args: string[], options: YtDlpRunnerOptions): Promise<YtDlpRunResult>;
};

export type YtDlpTranscriptProviderOptions = {
  binaryPath?: string;
  fallbackLanguages?: string[];
  now?: () => Date;
  runner?: YtDlpRunner;
  storage?: StorageAdapter;
  timeoutMs?: number;
};

type SelectedTrack = YtDlpCaptionTrack & {
  format: "vtt" | "srt";
};

export class YtDlpTranscriptProvider implements TranscriptProvider {
  private readonly binaryPath: string;
  private readonly fallbackLanguages: string[];
  private readonly now: () => Date;
  private readonly runner: YtDlpRunner;
  private readonly storage?: StorageAdapter;
  private readonly timeoutMs: number;

  constructor(options: YtDlpTranscriptProviderOptions = {}) {
    this.binaryPath = options.binaryPath ?? "yt-dlp";
    this.fallbackLanguages = options.fallbackLanguages ?? [];
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? createDefaultYtDlpRunner(this.binaryPath);
    this.storage = options.storage;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async getTranscript(video: VideoMetadata, request: TranscriptRequest = {}): Promise<Transcript> {
    let tracks: YtDlpCaptionTrack[];
    try {
      const listed = await this.runner.run(buildListSubtitleArgs(video.url), { timeoutMs: this.timeoutMs });
      tracks = parseYtDlpSubtitleList(listed.stdout);
    } catch (error) {
      if (isBlockedYtDlpError(error)) {
        return { videoId: video.id, status: "blocked", segments: [] };
      }
      throw error;
    }

    const selected = selectCaptionTrack(tracks, request, this.fallbackLanguages);
    if (!selected) {
      return {
        videoId: video.id,
        status: request.allowPaidTranscription ? "needs_transcription" : "missing",
        segments: [],
      };
    }

    const selectionKey = createSelectionCacheKey(video.id, selected);
    const cachedTranscriptKey = await this.storage?.get<string>(selectionKey);
    if (cachedTranscriptKey) {
      const cachedTranscript = await this.storage?.get<Transcript>(cachedTranscriptKey);
      if (cachedTranscript) {
        return cachedTranscript;
      }
    }

    let rawCaption: { filename: string; content: string };
    try {
      rawCaption = await this.extractCaption(video, selected);
    } catch (error) {
      if (isBlockedYtDlpError(error)) {
        return { videoId: video.id, status: "blocked", segments: [] };
      }
      throw error;
    }

    const sourceHash = createTranscriptSourceHash(rawCaption.content);
    const cacheKey = createTranscriptCacheKey({
      provider: "yt-dlp",
      videoId: video.id,
      language: selected.language,
      captionKind: selected.captionKind,
      sourceHash,
      parserVersion: PARSER_VERSION,
      options: { format: selected.format },
    });
    const cachedAfterExtraction = await this.storage?.get<Transcript>(cacheKey);
    if (cachedAfterExtraction) {
      await this.storage?.set(selectionKey, cacheKey);
      return cachedAfterExtraction;
    }

    const cues = selected.format === "srt" ? parseSrt(rawCaption.content) : parseVtt(rawCaption.content);
    const transcript: Transcript = {
      videoId: video.id,
      status: "available",
      provenance: {
        provider: "yt-dlp",
        language: selected.language,
        captionKind: selected.captionKind,
        sourceHash,
        extractedAt: this.now().toISOString(),
      },
      segments: normalizeTranscriptCues({
        videoId: video.id,
        language: selected.language,
        captionKind: selected.captionKind,
        cues,
      }),
    };

    await this.storage?.set(cacheKey, transcript);
    await this.storage?.set(selectionKey, cacheKey);
    return transcript;
  }

  private async extractCaption(video: VideoMetadata, selected: SelectedTrack): Promise<{ filename: string; content: string }> {
    const tempDir = await mkdtemp(join(tmpdir(), "learnframe-yt-dlp-"));
    try {
      const result = await this.runner.run(buildExtractSubtitleArgs(video.url, selected, tempDir), {
        cwd: tempDir,
        timeoutMs: this.timeoutMs,
      });
      const fromRunner = firstCaptionFile(result.files);
      if (fromRunner) {
        return fromRunner;
      }

      const files = await readdir(tempDir);
      const captionFile = files.find((file) => file.endsWith(".vtt") || file.endsWith(".srt"));
      if (!captionFile) {
        throw new LearnFrameError("RESOLUTION_FAILED", "yt-dlp did not produce a subtitle file");
      }
      return {
        filename: captionFile,
        content: await readFile(join(tempDir, captionFile), "utf8"),
      };
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }
}

export function buildListSubtitleArgs(url: string): string[] {
  return ["--ignore-config", "--skip-download", "--list-subs", "--no-warnings", "--no-playlist", url];
}

export function buildExtractSubtitleArgs(url: string, selected: SelectedTrack, outputDir: string): string[] {
  return [
    "--ignore-config",
    "--skip-download",
    "--no-warnings",
    "--no-playlist",
    selected.captionKind === "auto" ? "--write-auto-sub" : "--write-sub",
    "--sub-lang",
    selected.language,
    "--sub-format",
    selected.format,
    "--output",
    join(outputDir, "%(id)s.%(ext)s"),
    url,
  ];
}

export function parseYtDlpSubtitleList(stdout: string): YtDlpCaptionTrack[] {
  const tracks: YtDlpCaptionTrack[] = [];
  let captionKind: Exclude<CaptionKind, "transcribed"> | undefined;

  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.toLowerCase().includes("available automatic captions")) {
      captionKind = "auto";
      continue;
    }
    if (line.toLowerCase().includes("available subtitles")) {
      captionKind = "human";
      continue;
    }
    if (!captionKind || line.toLowerCase().startsWith("language")) {
      continue;
    }

    const match = line.match(/^(\S+)\s+.+?\s+([a-z0-9_,/.-]+)$/iu);
    if (match?.[1] && match[2]) {
      tracks.push({
        language: match[1],
        captionKind,
        formats: match[2].split(/[,/]/u).map((format) => format.trim()).filter(Boolean),
      });
    }
  }

  return tracks;
}

export function selectCaptionTrack(
  tracks: YtDlpCaptionTrack[],
  request: TranscriptRequest,
  providerFallbackLanguages: string[],
): SelectedTrack | undefined {
  const requestedLanguage = request.language ?? "en";
  const fallbackLanguages = [...new Set([requestedLanguage, "en", ...(request.fallbackLanguages ?? providerFallbackLanguages)])];
  const allowAutoCaptions = request.allowAutoCaptions ?? true;
  const preferHumanCaptions = request.preferHumanCaptions ?? true;
  const kinds: Array<Exclude<CaptionKind, "transcribed">> = preferHumanCaptions ? ["human", "auto"] : ["auto", "human"];

  for (const captionKind of kinds) {
    if (captionKind === "auto" && !allowAutoCaptions) {
      continue;
    }
    for (const language of fallbackLanguages) {
      const track = tracks.find((candidate) => candidate.captionKind === captionKind && candidate.language === language);
      const format = selectSubtitleFormat(track?.formats ?? []);
      if (track && format) {
        return { ...track, format };
      }
    }
  }

  return undefined;
}

function selectSubtitleFormat(formats: string[]): "vtt" | "srt" | undefined {
  if (formats.includes("vtt")) {
    return "vtt";
  }
  if (formats.includes("srt")) {
    return "srt";
  }
  return undefined;
}

function createDefaultYtDlpRunner(binaryPath: string): YtDlpRunner {
  return {
    async run(args, options) {
      try {
        const { stdout, stderr } = await execFileAsync(binaryPath, args, {
          cwd: options.cwd,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          shell: false,
          timeout: options.timeoutMs,
          windowsHide: true,
        });
        return { stdout, stderr };
      } catch (error) {
        throw normalizeYtDlpError(error);
      }
    },
  };
}

function firstCaptionFile(files: Record<string, string> | undefined): { filename: string; content: string } | undefined {
  if (!files) {
    return undefined;
  }
  const entry = Object.entries(files).find(([filename]) => filename.endsWith(".vtt") || filename.endsWith(".srt"));
  return entry ? { filename: entry[0], content: entry[1] } : undefined;
}

function createSelectionCacheKey(videoId: string, selected: SelectedTrack): string {
  return ["transcript-selection", "yt-dlp", videoId, selected.language, selected.captionKind, selected.format, PARSER_VERSION].join(":");
}

function isBlockedYtDlpError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return ["private", "unavailable", "age", "geo", "copyright", "blocked"].some((needle) => message.includes(needle));
}

function normalizeYtDlpError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new LearnFrameError("RESOLUTION_FAILED", String(error));
}
