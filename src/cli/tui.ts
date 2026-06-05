import * as readline from "node:readline";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseYoutubeUrl, createInMemorySourceResolver, createInMemoryStorage, createLearnFrame } from "../index.js";
import { buildExportPackResult } from "../export/pack.js";
import type { CourseProcessingState, Transcript, StorageAdapter, ArtifactKind } from "../contracts.js";

// ---------------------------------------------------------------------------
// ANSI palette
// ---------------------------------------------------------------------------
export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgGray: "\x1b[100m",
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function colored(c: string, text: string) { return `${c}${text}${C.reset}`; }
export function paint(c: string, text: string) { return `${c}${text}${C.reset}`; }
export function stripAnsi(str: string): string { return str.replace(ANSI_RE, ""); }

export function hr() { return paint(C.dim, "────────────────────────────────────────"); }
export function title(text: string) { return paint(C.bold + C.brightCyan, text); }
export function ok(text: string) { return `${paint(C.green, "✓")} ${text}`; }
export function fail(text: string) { return `${paint(C.red, "✗")} ${text}`; }
export function warn(text: string) { return `${paint(C.yellow, "⚠")} ${text}`; }
export function info(text: string) { return `${paint(C.brightBlue, "ℹ")} ${text}`; }
export function bullet(text: string) { return `  ${paint(C.brightCyan, "•")} ${text}`; }
export function numbered(index: number, text: string) { return `  ${paint(C.dim, `${index}.`)} ${text}`; }
export function badge(label: string, value: string) { return `${paint(C.dim, label)} ${paint(C.brightWhite, value)}`; }

// ---------------------------------------------------------------------------
// Chat bubble
// ---------------------------------------------------------------------------
export function chatBubble(author: string, authorColor: string, lines: string[]): string[] {
  const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length), stripAnsi(author).length + 2, 30);
  const w = Math.min(72, Math.max(44, maxLen + 4));
  const top = `╭─ ${authorColor}${author}${C.reset} ${"─".repeat(Math.max(0, w - stripAnsi(author).length - 4))}╮`;
  const body = lines.map((line) => {
    const clean = stripAnsi(line);
    const pad = " ".repeat(Math.max(0, w - clean.length));
    return `│ ${line}${pad} │`;
  });
  const bottom = `╰${"─".repeat(w)}╯`;
  return [top, ...body, bottom];
}

// ---------------------------------------------------------------------------
// Spinner (writes to stderr for live animation)
// ---------------------------------------------------------------------------
export function createSpinner(text: string) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let interval: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      let i = 0;
      interval = setInterval(() => {
        process.stderr.write(`\r  ${paint(C.brightCyan, frames[i] + " " + text)} `);
        i = (i + 1) % frames.length;
      }, 80);
    },
    stop(finalIcon = paint(C.green, "✓"), finalText = text) {
      if (interval) clearInterval(interval);
      process.stderr.write(`\r  ${finalIcon} ${finalText}        \n`);
    },
    fail(finalText = text) {
      if (interval) clearInterval(interval);
      process.stderr.write(`\r  ${paint(C.red, "✗")} ${finalText}        \n`);
    },
  };
}

// ---------------------------------------------------------------------------
// TUI context and session types
// ---------------------------------------------------------------------------
export type TuiContext = {
  courseDir: string;
  llmFactory: (apiKey: string) => any;
  transcriptFactory: (url: string, apiKey: string | undefined, useWhisper: boolean) => Promise<any>;
  processFactory: (url: string, apiKey: string, outputs: string, useWhisper?: boolean) => Promise<any>;
  exportFactory: (courseId: string, outputDir?: string) => Promise<{ courseId: string; jsonPath: string; markdownPath: string }>;
  resolveUrl: (url: string) => Promise<any>;
  listSavedCourses: () => string[];
  loadSavedCourse: (id: string) => any | undefined;
  saveCourse: (id: string, state: any) => void;
  deleteCourse: (id: string) => void;
  getApiKey: () => string | undefined;
  now: () => Date;
};

export type TuiState = {
  currentCourse: string | undefined;
  currentUrl: string | undefined;
};

export type TuiOutput = { lines: string[]; state: TuiState };
export type TuiSession = {
  handle(line: string): Promise<TuiOutput>;
  getState(): TuiState;
};

export function makeTuiSession(ctx: TuiContext, initial: TuiState = { currentCourse: undefined, currentUrl: undefined }): TuiSession {
  const state = { ...initial };
  const llm: { instance: any | undefined } = { instance: undefined };

  const fmt = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  function respond(lines: string[]): string[] {
    return chatBubble("LearnFrame", C.brightCyan, lines);
  }

  async function handle(input: string): Promise<TuiOutput> {
    const lines: string[] = [];
    const trimmed = input.trim();
    if (!trimmed) return { lines: [], state };

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rest = parts.slice(1);

    if (cmd === "exit" || cmd === "quit") { lines.push("exit"); return { lines, state }; }
    if (cmd === "help") {
      lines.push(title("LearnFrame TUI Commands"));
      lines.push(hr());
      lines.push(bullet("process <url> [--outputs kind,...] [--whisper]"));
      lines.push(bullet("ask <question>                     Ask about loaded course"));
      lines.push(bullet("resolve <url>                      Resolve YouTube URL"));
      lines.push(bullet("course <id>                        Load a saved course"));
      lines.push(bullet("courses                            List saved courses"));
      lines.push(bullet("status                             Show current course status"));
      lines.push(bullet("artifacts                          List artifacts for current course"));
      lines.push(bullet("transcript <url> [--whisper]       Extract or show transcript"));
      lines.push(bullet("export [courseId] [--dir path]     Export course as JSON + Markdown"));
      lines.push(bullet("delete <id>                        Delete a saved course"));
      lines.push(bullet("config                             Show configuration"));
      lines.push(bullet("url                                Show current course URL"));
      lines.push(bullet("help                               Show this help"));
      lines.push(bullet("exit                               Quit"));
      lines.push(hr());
      return { lines, state };
    }

    if (cmd === "config") {
      const apiKey = ctx.getApiKey();
      lines.push(...respond([title("Config"), badge("OPENAI_API_KEY:", apiKey ? "set" : "not set")]));
      return { lines, state };
    }

    if (cmd === "delete") {
      const id = rest[0];
      if (!id) { lines.push(warn("Usage: delete <id>")); return { lines, state }; }
      ctx.deleteCourse(id);
      lines.push(ok(`Deleted "${id}"`));
      if (state.currentCourse === id) {
        state.currentCourse = undefined;
        state.currentUrl = undefined;
        lines.push(info("Current course cleared"));
      }
      return { lines, state };
    }

    if (cmd === "status") {
      if (!state.currentCourse) { lines.push(warn("No course loaded")); return { lines, state }; }
      const s = ctx.loadSavedCourse(state.currentCourse);
      if (!s) { lines.push(fail(`Course "${state.currentCourse}" not found`)); return { lines, state }; }
      const videoCount = Array.isArray(s.videos) ? s.videos.length : 0;
      const chunkCount = s.chunkCount ?? (Array.isArray(s.chunks) ? s.chunks.length : 0);
      const artifactCount = Array.isArray(s.artifacts) ? s.artifacts.length : 0;
      const sync = s.sync ?? { added: [], updated: [], skipped: [] };
      lines.push(...respond([
        title(`Course: ${state.currentCourse}`),
        badge("URL:", s.url ?? "—"),
        badge("Videos:", String(videoCount)),
        badge("Chunks:", String(chunkCount)),
        badge("Artifacts:", String(artifactCount)),
        badge("Created:", s.createdAt ?? "—"),
        badge("Sync:", `${sync.added.length} added · ${sync.updated.length} updated · ${sync.skipped.length} skipped`),
      ]));
      return { lines, state };
    }

    if (cmd === "artifacts") {
      if (!state.currentCourse) { lines.push(warn("No course loaded")); return { lines, state }; }
      const s = ctx.loadSavedCourse(state.currentCourse);
      if (!s) { lines.push(fail(`Course "${state.currentCourse}" not found`)); return { lines, state }; }
      const artifacts: any[] = s.artifacts ?? [];
      if (artifacts.length === 0) {
        lines.push(...respond([info("No artifacts generated yet")]));
      } else {
        lines.push(...respond([
          title(`Artifacts (${artifacts.length})`),
          ...artifacts.map((a: any) => bullet(`${a.kind} — ${a.videoId ?? "course"} (${a.modelRole ?? "unknown"})`)),
        ]));
      }
      return { lines, state };
    }

    if (cmd === "export") {
      let courseId = state.currentCourse;
      let outputDir: string | undefined;

      for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (token === "--dir") {
          outputDir = rest[index + 1];
          index += 1;
          continue;
        }
        if (!courseId) {
          courseId = token;
        }
      }

      if (!courseId) {
        lines.push(warn("Usage: export [courseId] [--dir path]"));
        return { lines, state };
      }

      try {
        const exported = await ctx.exportFactory(courseId, outputDir);
        lines.push(...respond([
          ok(`Exported ${exported.courseId}`),
          badge("JSON:", exported.jsonPath),
          badge("Markdown:", exported.markdownPath),
        ]));
      } catch (e: any) {
        lines.push(fail(`Error: ${e.message}`));
      }
      return { lines, state };
    }

    if (cmd === "courses") {
      const saved = ctx.listSavedCourses();
      if (saved.length === 0) {
        lines.push(...respond([info("No saved courses")]));
      } else {
        lines.push(...respond(saved.map((c, i) => numbered(i + 1, c))));
      }
      return { lines, state };
    }

    if (cmd === "url") {
      lines.push(state.currentUrl ? badge("URL:", state.currentUrl) : info("No course loaded"));
      return { lines, state };
    }

    if (cmd === "course") {
      const id = rest[0];
      if (!id) { lines.push(warn("Usage: course <id>")); return { lines, state }; }
      const s = ctx.loadSavedCourse(id);
      if (!s) { lines.push(fail(`Course "${id}" not found`)); return { lines, state }; }
      state.currentCourse = id;
      state.currentUrl = s.url;
      lines.push(ok(`Loaded ${id} — ${s.chunkCount || 0} chunks, ${(s.artifacts || []).length} artifacts`));
      return { lines, state };
    }

    if (cmd === "resolve") {
      const url = rest.join(" ");
      if (!url) { lines.push(warn("Usage: resolve <url>")); return { lines, state }; }
      try {
        const result = await ctx.resolveUrl(url);
        state.currentCourse = result.courseId;
        state.currentUrl = url;
        lines.push(...respond([
          ok(`Resolved: ${result.videos.length} video(s)`),
          ...result.videos.map((v: any) => bullet(`${v.id} — ${v.title || "no title"}`)),
        ]));
      } catch (e: any) { lines.push(fail(`Error: ${e.message}`)); }
      return { lines, state };
    }

    if (cmd === "transcript") {
      const rawInput = rest.join(" ");
      const useWhisper = rawInput.includes("--whisper");
      const url = rawInput.replace(/--whisper/g, "").trim().split(/\s+/)[0];

      if (!url) {
        if (!state.currentCourse) { lines.push(warn("Usage: transcript <url> [--whisper] or load a course first")); return { lines, state }; }
        const s = ctx.loadSavedCourse(state.currentCourse);
        if (!s || !Array.isArray(s.transcripts) || s.transcripts.length === 0) {
          lines.push(info("No transcript available for this course"));
          return { lines, state };
        }
        const t: Transcript = s.transcripts[0];
        lines.push(...respond([
          badge("Status:", `${t.status} — ${t.segments.length} segments`),
          ...(t.provenance ? [badge("Source:", `${t.provenance.provider} / ${t.provenance.language} / ${t.provenance.captionKind}`)] : []),
          `  ${paint(C.dim, "\"")}${t.segments.slice(0, 3).map((seg: any) => seg.text).join(" ")}${paint(C.dim, "...\"")}`,
        ]));
        return { lines, state };
      }

      const apiKey = useWhisper ? ctx.getApiKey() : undefined;
      lines.push(paint(C.dim, "Extracting transcript..."));
      try {
        const t = await ctx.transcriptFactory(url, apiKey ?? undefined, useWhisper);
        lines.push(...respond([
          badge("Status:", `${t.status} — ${t.segments.length} segments`),
          ...(t.provenance ? [badge("Source:", `${t.provenance.provider} / ${t.provenance.language} / ${t.provenance.captionKind}`)] : []),
          `  ${paint(C.dim, "\"")}${t.segments.slice(0, 3).map((seg: any) => seg.text).join(" ")}${paint(C.dim, "...\"")}`,
        ]));
      } catch (e: any) { lines.push(fail(`Error: ${e.message}`)); }
      return { lines, state };
    }

    if (cmd === "process") {
      const apiKey = ctx.getApiKey();
      if (!apiKey) { lines.push(fail("OPENAI_API_KEY not set")); return { lines, state }; }
      const useWhisper = rest.includes("--whisper");
      const otIdx = rest.findIndex((s) => s === "--outputs");
      const outputs = otIdx >= 0 ? rest[otIdx + 1] : "notes,summary";
      const urlParts = otIdx >= 0 ? rest.slice(0, otIdx) : rest.filter((s) => s !== "--whisper");
      const url = urlParts.join(" ");
      if (!url) { lines.push(warn("Usage: process <url> [--outputs notes,summary] [--whisper]")); return { lines, state }; }

      lines.push(paint(C.dim, "Extracting transcript..."));
      try {
        const result = await ctx.processFactory(url, apiKey, outputs, useWhisper);
        state.currentCourse = result.courseId;
        state.currentUrl = url;
        lines.push(...respond([
          ok(`Done! ${result.artifactCount} artifacts generated`),
          ...result.artifactKinds.map((k: string) => bullet(`${k} (${result.modelRole})`)),
          info("Saved. Try: ask \"what is this course about?\""),
          paint(C.brightGreen, `SAVED:${result.courseId}`),
        ]));
      } catch (e: any) { lines.push(fail(`Error: ${e.message}`)); }
      return { lines, state };
    }

    if (cmd === "ask") {
      const apiKey = ctx.getApiKey();
      if (!apiKey) { lines.push(fail("OPENAI_API_KEY not set")); return { lines, state }; }
      if (!state.currentCourse) { lines.push(warn("No course loaded. Run 'process <url>' or 'course <id>' first.")); return { lines, state }; }
      const question = rest.join(" ");
      if (!question) { lines.push(warn("Usage: ask <question>")); return { lines, state }; }

      try {
        if (!llm.instance) llm.instance = await ctx.llmFactory(apiKey);
        const courseState = ctx.loadSavedCourse(state.currentCourse);
        if (!courseState) { lines.push(fail(`Course "${state.currentCourse}" not found on disk.`)); return { lines, state }; }

        const { createRetrievalQaEngine } = await import("../qa/retrieval.js");
        const engine = createRetrievalQaEngine({ chunks: courseState.chunks, artifacts: courseState.artifacts, llm: llm.instance, maxContextChunks: 4 });
        const answer = await engine.ask({ courseId: state.currentCourse, question });

        if (answer.status === "insufficient_context") {
          lines.push(...respond([
            answer.answer,
            `  ${paint(C.dim, `(reason: ${answer.confidence.reason.slice(0, 200)})`)}`,
          ]));
          return { lines, state };
        }
        const ansLines: string[] = [paint(C.brightWhite, answer.answer)];
        if (answer.citations.length > 0) {
          ansLines.push("");
          ansLines.push(title(`Citations (${answer.citations.length})`));
          answer.citations.forEach((c: any) => ansLines.push(bullet(`${c.videoId} [${fmt(c.startSeconds)}-${fmt(c.endSeconds)}]`)));
        }
        if (answer.replayRanges.length > 0) {
          ansLines.push("");
          ansLines.push(title("Replay"));
          answer.replayRanges.forEach((r: any) => ansLines.push(bullet(`${r.videoId} [${fmt(r.startSeconds)}-${fmt(r.endSeconds)}]`)));
        }
        if (answer.followUpQuestions.length > 0) {
          ansLines.push("");
          ansLines.push(title("Follow-ups"));
          answer.followUpQuestions.forEach((q: string) => ansLines.push(bullet(q)));
        }
        lines.push(...respond(ansLines));
      } catch (e: any) { lines.push(fail(`Error: ${e.message}`)); }
      return { lines, state };
    }

    if (state.currentCourse) {
      lines.push(warn(`Unknown command "${cmd}". To ask a question use: ask ${trimmed}`));
    } else {
      lines.push(warn(`Unknown command: ${cmd}. Type 'help' for commands.`));
    }
    return { lines, state };
  }

  return {
    handle,
    getState: () => state,
  };
}

// ---------------------------------------------------------------------------
// Default context (real filesystem, real SDK)
// ---------------------------------------------------------------------------
export function defaultTuiContext(): TuiContext {
  const COURSE_DIR = join(homedir(), ".learnframe", "courses");
  mkdirSync(COURSE_DIR, { recursive: true });

  function createFileSystemStorageAdapter(): StorageAdapter {
    return {
      async get<T>(key: string): Promise<T | undefined> {
        const courseId = key.split(":").pop();
        if (!courseId) return undefined;
        const p = join(COURSE_DIR, `${courseId}.json`);
        if (!existsSync(p)) return undefined;
        const raw = JSON.parse(readFileSync(p, "utf8"));
        return raw as T | undefined;
      },
      async set<T>(key: string, value: T): Promise<void> {
        const courseId = key.split(":").pop();
        if (!courseId) return;
        writeFileSync(join(COURSE_DIR, `${courseId}.json`), JSON.stringify(value, null, 2));
      },
      async delete(key: string): Promise<void> {
        const courseId = key.split(":").pop();
        if (!courseId) return;
        const p = join(COURSE_DIR, `${courseId}.json`);
        if (existsSync(p)) unlinkSync(p);
      },
      async has(key: string): Promise<boolean> {
        const courseId = key.split(":").pop();
        if (!courseId) return false;
        return existsSync(join(COURSE_DIR, `${courseId}.json`));
      },
    };
  }

  return {
    courseDir: COURSE_DIR,
    getApiKey: () => process.env.OPENAI_API_KEY,
    now: () => new Date(),

    listSavedCourses: () => {
      try { return readdirSync(COURSE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")); } catch { return []; }
    },

    loadSavedCourse: (id: string) => {
      const p = join(COURSE_DIR, `${id}.json`);
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
    },

    saveCourse: (id: string, state: any) => {
      writeFileSync(join(COURSE_DIR, `${id}.json`), JSON.stringify(state, null, 2));
    },

    deleteCourse: (id: string) => {
      const p = join(COURSE_DIR, `${id}.json`);
      if (existsSync(p)) unlinkSync(p);
    },

    async resolveUrl(url: string) {
      const p = parseYoutubeUrl(url);
      const r = createInMemorySourceResolver({ videos: { [p.videoId ?? url]: { id: p.videoId ?? url, url, title: "YouTube video" } } });
      return r.resolve({ type: "video", url: p.canonicalUrl, videoId: p.videoId }, { storage: createInMemoryStorage(), reportProgress: async () => {} });
    },

    async llmFactory(apiKey: string) {
      const { createOpenAiLlmAdapter } = await import("./llm.js");
      return createOpenAiLlmAdapter(apiKey);
    },

    async transcriptFactory(url: string, apiKey: string | undefined, useWhisper: boolean) {
      const [{ YtDlpTranscriptProvider }, { WhisperTranscriptProvider }] = await Promise.all([
        import("../adapters/yt-dlp-transcript.js"),
        import("../adapters/whisper-transcript.js"),
      ]);
      const storage = createInMemoryStorage();
      const vid = parseYoutubeUrl(url).videoId ?? url;
      const spinner = createSpinner("Extracting captions");
      spinner.start();
      const t = new YtDlpTranscriptProvider({ storage, timeoutMs: 120_000 });
      try {
        const r = await t.getTranscript({ id: vid, url, availability: "available" as any }, { language: "en" });
        if (r.status === "missing" && useWhisper && apiKey) {
          spinner.stop(paint(C.yellow, "⏳"), "No captions. Transcribing with Whisper...");
          const w = new WhisperTranscriptProvider({ apiKey, storage, timeoutMs: 300_000 });
          const wr = await w.getTranscript({ id: vid, url, availability: "available" as any }, { allowPaidTranscription: true });
          spinner.stop(paint(C.green, "✓"), "Transcription complete");
          return wr;
        }
        spinner.stop(paint(C.green, "✓"), `Got ${r.segments.length} segments`);
        return r;
      } catch (e) {
        spinner.fail("Transcript extraction failed");
        throw e;
      }
    },

    async processFactory(url: string, apiKey: string, outputs: string, useWhisper?: boolean) {
      const spinner = createSpinner("Processing video");
      spinner.start();
      try {
        const [{ YtDlpTranscriptProvider }, { createOpenAiLlmAdapter }] = await Promise.all([
          import("../adapters/yt-dlp-transcript.js"),
          import("./llm.js"),
        ]);
        const storage = createFileSystemStorageAdapter();
        const llm = await createOpenAiLlmAdapter(apiKey);
        const transcriptProvider = new YtDlpTranscriptProvider({ storage: createInMemoryStorage(), timeoutMs: 120_000 });
        const sdk = createLearnFrame({
          sourceResolver: createInMemorySourceResolver({}),
          storage,
          transcriptProvider,
          llm,
          onProgress: (event) => {
            const icon = event.status === "completed" ? paint(C.green, "✓") : event.status === "failed" ? paint(C.red, "✗") : paint(C.brightCyan, "⏳");
            console.error(`  ${icon} ${event.stage}: ${event.message}`);
          },
        });
        const result = await sdk.process({
          source: { type: "video", url },
          outputs: outputs.split(",").map((s) => s.trim()) as ArtifactKind[],
          transcript: useWhisper ? { allowPaidTranscription: true } : undefined,
        });
        spinner.stop(paint(C.green, "✓"), "Processing complete");
        return {
          courseId: result.courseId,
          url,
          artifactCount: result.artifacts.length,
          artifactKinds: result.artifacts.map((a: any) => a.kind),
          modelRole: "cheap",
        };
      } catch (e) {
        spinner.fail("Processing failed");
        throw e;
      }
    },

    async exportFactory(courseId: string, outputDir?: string) {
      const savedCourse = this.loadSavedCourse(courseId);
      if (!savedCourse) {
        throw new Error(`Course "${courseId}" not found`);
      }

      const state = coerceSavedCourseToProcessingState(savedCourse);
      const exportPack = buildExportPackResult(state, this.now().toISOString());
      const exportDir = outputDir ?? join(COURSE_DIR, "exports", courseId);
      mkdirSync(exportDir, { recursive: true });
      const jsonPath = join(exportDir, `${courseId}.json`);
      const markdownPath = join(exportDir, `${courseId}.md`);
      writeFileSync(jsonPath, exportPack.json);
      writeFileSync(markdownPath, exportPack.markdown);

      return { courseId, jsonPath, markdownPath };
    },
  };
}

function coerceSavedCourseToProcessingState(savedCourse: any): CourseProcessingState {
  const now = new Date().toISOString();
  const courseId = String(savedCourse.courseId ?? savedCourse.id ?? hashCourseUrl(savedCourse.url ?? "course"));
  const videos = Array.isArray(savedCourse.videos) && savedCourse.videos.length > 0
    ? savedCourse.videos
    : [{ id: courseId, url: savedCourse.url ?? "", availability: "available", position: 0 }];
  const transcripts: Transcript[] = Array.isArray(savedCourse.transcripts)
    ? savedCourse.transcripts
    : videos.map((video: any) => ({ videoId: video.id, status: "missing", segments: [] }));
  const chunks = Array.isArray(savedCourse.chunks) ? savedCourse.chunks : [];
  const artifacts = Array.isArray(savedCourse.artifacts) ? savedCourse.artifacts : [];
  const processedVideos = Object.fromEntries(videos.map((video: any) => {
    const transcript = transcripts.find((entry) => entry.videoId === video.id) ?? { videoId: video.id, status: "missing", segments: [] };
    const videoChunks = chunks.filter((chunk: any) => chunk.videoId === video.id);
    const videoArtifacts = artifacts.filter((artifact: any) => artifact.videoId === video.id);
    const fingerprint = createHash("sha256")
      .update(`${video.id}:${video.url ?? ""}:${video.etag ?? ""}`)
      .digest("hex");
    return [
      video.id,
      {
        video,
        fingerprint,
        transcript,
        chunks: videoChunks,
        artifacts: videoArtifacts,
      },
    ];
  }));

  return {
    courseId,
    source: savedCourse.source ?? { type: "video", url: savedCourse.url ?? "" },
    playlist: savedCourse.playlist ?? {
      id: savedCourse.playlist?.id ?? courseId,
      url: savedCourse.url ?? "",
      title: savedCourse.playlist?.title,
      description: savedCourse.playlist?.description,
      videos,
    },
    videos,
    transcripts,
    chunks,
    artifacts,
    processedVideos,
    sourceResolution: savedCourse.sourceResolution,
    sync: savedCourse.sync ?? { added: [], updated: [], skipped: videos.map((video: any) => video.id) },
    createdAt: savedCourse.createdAt ?? now,
    updatedAt: savedCourse.updatedAt ?? now,
  };
}

function hashCourseUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}
