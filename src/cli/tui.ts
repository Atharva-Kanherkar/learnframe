import * as readline from "node:readline";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseYoutubeUrl, createInMemorySourceResolver, createInMemoryStorage } from "../index.js";
import { buildExportPackResult } from "../export/pack.js";
import type { CourseProcessingState, Transcript } from "../contracts.js";

export const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", magenta: "\x1b[35m" };
export function colored(c: string, text: string) { return `${c}${text}${C.reset}`; }

export type TuiContext = {
  courseDir: string;
  llmFactory: (apiKey: string) => any;
  transcriptFactory: (url: string, apiKey: string | undefined, useWhisper: boolean) => Promise<any>;
  processFactory: (url: string, apiKey: string, outputs: string) => Promise<any>;
  exportFactory: (courseId: string, outputDir?: string) => Promise<{ courseId: string; jsonPath: string; markdownPath: string }>;
  resolveUrl: (url: string) => Promise<any>;
  listSavedCourses: () => string[];
  loadSavedCourse: (id: string) => any | undefined;
  saveCourse: (id: string, state: any) => void;
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

  const out = (text: string) => text;

  async function handle(input: string): Promise<TuiOutput> {
    const lines: string[] = [];
    const trimmed = input.trim();
    if (!trimmed) return { lines: [], state };

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rest = parts.slice(1);

    if (cmd === "exit" || cmd === "quit") { lines.push("exit"); return { lines, state }; }
    if (cmd === "help") {
      lines.push("LearnFrame TUI Commands");
      lines.push("process <url> [--outputs kind,...]   Full pipeline: captions → chunks → artifacts → save");
      lines.push("ask <question>                     Ask about loaded course (timestamp citations)");
      lines.push("resolve <url>                      Resolve YouTube URL to metadata");
      lines.push("course <id>                        Load a saved course");
      lines.push("courses                            List saved courses");
      lines.push("transcript <url> [--whisper]       Extract captions or transcribe");
      lines.push("export [courseId] [--dir path]     Export saved course as JSON + Markdown");
      lines.push("url                                Show current course URL");
      lines.push("help                               Show this help");
      lines.push("exit                               Quit");
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
        lines.push("Usage: export [courseId] [--dir path]");
        return { lines, state };
      }

      try {
        const exported = await ctx.exportFactory(courseId, outputDir);
        lines.push(`Exported ${exported.courseId}`);
        lines.push(`JSON: ${exported.jsonPath}`);
        lines.push(`Markdown: ${exported.markdownPath}`);
      } catch (e: any) {
        lines.push(`Error: ${e.message}`);
      }
      return { lines, state };
    }

    if (cmd === "courses") {
      const saved = ctx.listSavedCourses();
      if (saved.length === 0) { lines.push("No saved courses"); } else { saved.forEach((c) => lines.push(c)); }
      return { lines, state };
    }

    if (cmd === "url") {
      lines.push(state.currentUrl ?? "No course loaded");
      return { lines, state };
    }

    if (cmd === "course") {
      const id = rest[0];
      if (!id) { lines.push("Usage: course <id>"); return { lines, state }; }
      const s = ctx.loadSavedCourse(id);
      if (!s) { lines.push(`Course "${id}" not found`); return { lines, state }; }
      state.currentCourse = id;
      state.currentUrl = s.url;
      lines.push(`Loaded ${id} — ${s.chunkCount || 0} chunks, ${(s.artifacts || []).length} artifacts`);
      return { lines, state };
    }

    if (cmd === "resolve") {
      const url = rest.join(" ");
      if (!url) { lines.push("Usage: resolve <url>"); return { lines, state }; }
      try {
        const result = await ctx.resolveUrl(url);
        state.currentCourse = result.courseId;
        state.currentUrl = url;
        lines.push(`Resolved: ${result.videos.length} video(s)`);
        result.videos.forEach((v: any) => lines.push(`${v.id} — ${v.title || "no title"}`));
      } catch (e: any) { lines.push(`Error: ${e.message}`); }
      return { lines, state };
    }

    if (cmd === "transcript") {
      const url = rest.join(" ").replace(/--whisper/g, "").split(/\s+/)[0];
      if (!url) { lines.push("Usage: transcript <url> [--whisper]"); return { lines, state }; }
      const useWhisper = rest.join(" ").includes("--whisper");
      const apiKey = useWhisper ? ctx.getApiKey() : undefined;
      lines.push("Extracting transcript...");
      try {
        const t = await ctx.transcriptFactory(url, apiKey ?? undefined, useWhisper);
        lines.push(`Status: ${t.status} — ${t.segments.length} segments`);
        if (t.provenance) lines.push(`${t.provenance.provider} / ${t.provenance.language} / ${t.provenance.captionKind}`);
        const preview = t.segments.slice(0, 3).map((s: any) => s.text).join(" ");
        lines.push(`"${preview}..."`);
      } catch (e: any) { lines.push(`Error: ${e.message}`); }
      return { lines, state };
    }

    if (cmd === "process") {
      const apiKey = ctx.getApiKey();
      if (!apiKey) { lines.push("OPENAI_API_KEY not set"); return { lines, state }; }
      const otIdx = rest.findIndex((s) => s === "--outputs");
      const outputs = otIdx >= 0 ? rest[otIdx + 1] : "notes,summary";
      const url = rest.slice(0, otIdx >= 0 ? otIdx : rest.length).join(" ");
      if (!url) { lines.push("Usage: process <url> [--outputs notes,summary]"); return { lines, state }; }

      lines.push("Extracting transcript...");
      try {
        const result = await ctx.processFactory(url, apiKey, outputs);
        state.currentCourse = result.courseId;
        state.currentUrl = url;
        lines.push(`Done! ${result.artifactCount} artifacts generated.`);
        result.artifactKinds.forEach((k: string) => lines.push(`${k} (${result.modelRole})`));
        lines.push(`Saved. Try: ask "what is this course about?"`);
        lines.push(`SAVED:${result.courseId}`);
      } catch (e: any) { lines.push(`Error: ${e.message}`); }
      return { lines, state };
    }

    if (cmd === "ask") {
      const apiKey = ctx.getApiKey();
      if (!apiKey) { lines.push("OPENAI_API_KEY not set"); return { lines, state }; }
      if (!state.currentCourse) { lines.push("No course loaded. Run 'process <url>' or 'course <id>' first."); return { lines, state }; }
      const question = rest.join(" ");
      if (!question) { lines.push("Usage: ask <question>"); return { lines, state }; }

      try {
        if (!llm.instance) llm.instance = await ctx.llmFactory(apiKey);
        const courseState = ctx.loadSavedCourse(state.currentCourse);
        if (!courseState) { lines.push(`Course "${state.currentCourse}" not found on disk.`); return { lines, state }; }

        const { createRetrievalQaEngine } = await import("../qa/retrieval.js");
        const engine = createRetrievalQaEngine({ chunks: courseState.chunks, artifacts: courseState.artifacts, llm: llm.instance, maxContextChunks: 4 });
        const answer = await engine.ask({ courseId: state.currentCourse, question });

        if (answer.status === "insufficient_context") {
          lines.push(answer.answer);
          lines.push(`(reason: ${answer.confidence.reason.slice(0, 200)})`);
          return { lines, state };
        }
        lines.push(answer.answer);
        if (answer.citations.length > 0) {
          lines.push(`Citations (${answer.citations.length}):`);
          answer.citations.forEach((c: any) => lines.push(`  ${c.videoId} [${fmt(c.startSeconds)}-${fmt(c.endSeconds)}]`));
        }
        if (answer.replayRanges.length > 0) {
          lines.push("Replay:");
          answer.replayRanges.forEach((r: any) => lines.push(`  ${r.videoId} [${fmt(r.startSeconds)}-${fmt(r.endSeconds)}]`));
        }
        if (answer.followUpQuestions.length > 0) {
          lines.push("Follow-ups:");
          answer.followUpQuestions.forEach((q: string) => lines.push(`  - ${q}`));
        }
      } catch (e: any) { lines.push(`Error: ${e.message}`); }
      return { lines, state };
    }

    if (state.currentCourse) {
      lines.push(`Unknown command "${cmd}". To ask a question use: ask ${trimmed}`);
    } else {
      lines.push(`Unknown command: ${cmd}. Type 'help' for commands.`);
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
      const t = new YtDlpTranscriptProvider({ storage, timeoutMs: 120_000 });
      console.error(`  Extracting captions for ${vid}...`);
      const r = await t.getTranscript({ id: vid, url, availability: "available" as any }, { language: "en" });
      if (r.status === "missing" && useWhisper && apiKey) {
        console.error("  No captions found. Transcribing with OpenAI Whisper (may take 1-2 min)...");
        const w = new WhisperTranscriptProvider({ apiKey, storage, timeoutMs: 300_000 });
        return w.getTranscript({ id: vid, url, availability: "available" as any }, { allowPaidTranscription: true });
      }
      console.error(`  Got ${r.segments.length} segments (${r.status}, ${r.provenance?.captionKind ?? "none"}).`);
      return r;
    },

    async processFactory(url: string, apiKey: string, outputs: string) {
      const [{ chunkTranscript }, { createLowCostArtifactEngine }] = await Promise.all([
        import("../chunking/chunker.js"),
        import("../artifacts/engine.js"),
      ]);
      const storage = createInMemoryStorage();
      const transcript = await this.transcriptFactory!(url, apiKey, false);
      if (transcript.status !== "available" || transcript.segments.length === 0) {
        throw new Error("Transcript unavailable");
      }
      const chunks = chunkTranscript(transcript);
      const kinds = outputs.split(",").map((s) => s.trim()) as any[];
      console.error(`  Chunked into ${chunks.length} chunks. Generating ${kinds.join(", ")}...`);
      const llm = await this.llmFactory(apiKey);
      const engine = createLowCostArtifactEngine({ llm, storage, maxConcurrentChunkNotes: 3 });
      const artifacts = await engine.generate({ courseId: parseYoutubeUrl(url).videoId ?? url, chunks, outputs: kinds });
      console.error(`  Generated ${artifacts.length} artifacts.`);
      const courseId = parseYoutubeUrl(url).videoId ?? url;
      this.saveCourse(courseId, {
        courseId,
        url,
        source: { type: "video", url },
        playlist: {
          id: courseId,
          url,
          title: parseYoutubeUrl(url).videoId ?? "YouTube video",
          videos: [{ id: courseId, url, availability: "available", position: 0 }],
        },
        videos: [{ id: courseId, url, availability: "available", position: 0 }],
        createdAt: new Date().toISOString(),
        chunkCount: chunks.length,
        chunks,
        transcripts: [transcript],
        artifacts,
        sync: { added: [courseId], updated: [], skipped: [] },
      });
      return { courseId, url, artifactCount: artifacts.length, artifactKinds: artifacts.map((a: any) => a.kind), modelRole: "cheap" };
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
