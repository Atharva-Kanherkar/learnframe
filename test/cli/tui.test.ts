import { describe, expect, it, beforeEach, vi } from "vitest";
import { makeTuiSession, paint, C, userBubble, assistantBubble, generateHtmlArtifact, stripAnsi } from "../../src/cli/tui.js";
import type { TuiContext, TuiSession } from "../../src/cli/tui.js";
import type { VideoPlayer } from "../../src/cli/video-player.js";

function fakeCtx(overrides: Partial<TuiContext> = {}): TuiContext {
  const saved: Record<string, any> = {};
  return {
    courseDir: "/tmp/.learnframe/courses",
    getApiKey: () => "test-api-key",
    now: () => new Date("2026-01-01"),
    listSavedCourses: () => Object.keys(saved),
    loadSavedCourse: (id) => saved[id],
    saveCourse: (id, state) => { saved[id] = state; },
    deleteCourse: (id) => { delete saved[id]; },
    resolveUrl: async (url) => ({ courseId: "resolved-123", videos: [{ id: "abc123", title: "Test Video" }] }),
    llmFactory: () => ({ async generateStructured(req: any) { return { fake: "response", task: req.task }; } }),
    transcriptFactory: async () => ({ status: "available", segments: [{ id: "s1", videoId: "v1", startSeconds: 0, endSeconds: 2, text: "Hello world" }], provenance: { provider: "yt-dlp", language: "en", captionKind: "auto" } }),
    processFactory: async (url, apiKey, outputs, useWhisper) => ({ courseId: "proc-1", url, artifactCount: 3, artifactKinds: ["notes", "summary", "syllabus"], modelRole: "cheap" }),
    exportFactory: async (courseId, outputDir) => ({ courseId, jsonPath: `/tmp/${courseId}.json`, markdownPath: `/tmp/${courseId}.md` }),
    videoPlayer: createFakeVideoPlayer(),
    ...overrides,
  };
}

function createFakeVideoPlayer(): VideoPlayer {
  let playing = false;
  let backend: import("../../src/cli/video-player.js").VideoBackend | undefined;
  return {
    async play(_videoId: string, _startSeconds: number, preferredBackend?: import("../../src/cli/video-player.js").VideoBackend) {
      playing = true;
      backend = preferredBackend ?? "browser";
      return { backend, message: `Playing with ${backend}` };
    },
    async stop() {
      playing = false;
      backend = undefined;
    },
    isPlaying: () => playing,
    getBackend: () => backend,
  };
}

function lines(session: TuiSession, input: string): Promise<string[]> {
  return session.handle(input).then((r) => r.lines);
}

function contains(output: string[], text: string): boolean {
  return output.some((line) => stripAnsi(line).includes(text));
}

describe("TUI modes", () => {
  it("starts in command mode", async () => {
    const session = makeTuiSession(fakeCtx());
    expect(session.getState().mode).toBe("command");
  });

  it("switches to chat mode when course loaded", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", chunkCount: 10, artifacts: [] });
    const session = makeTuiSession(ctx);
    await lines(session, "course abc123");
    expect(session.getState().mode).toBe("chat");
  });

  it("switches to command mode on /quit", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com" });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    await lines(session, "/quit");
    expect(session.getState().mode).toBe("command");
    expect(session.getState().currentCourse).toBeUndefined();
  });
});

describe("TUI chat", () => {
  it("shows user message as bubble in chat mode", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", chunks: [{ id: "c1", videoId: "v1", startSeconds: 0, endSeconds: 10, text: "content" }], artifacts: [] });
    ctx.llmFactory = () => ({
      async generateStructured() {
        return { answer: "Answer here.", status: "answered", citations: [{ videoId: "v1", startSeconds: 0, endSeconds: 10, chunkId: "c1", text: "content" }], replayRanges: [], followUpQuestions: [], confidence: { score: 0.9, reason: "grounded" } };
      },
    });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "what is this?");
    expect(contains(output, "You")).toBe(true);
    expect(contains(output, "what is this?")).toBe(true);
    expect(contains(output, "Answer here.")).toBe(true);
  });

  it("does NOT treat plain text as ask in command mode", async () => {
    const session = makeTuiSession(fakeCtx());
    const output = await lines(session, "what is this?");
    expect(contains(output, "Unknown")).toBe(true);
  });
});

describe("TUI slash commands", () => {
  it("/status shows course info", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", videos: [{ id: "v1" }], chunks: [{ id: "c1" }], artifacts: [{ kind: "notes" }], createdAt: "2026-01-01", sync: { added: ["v1"], updated: [], skipped: [] } });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/status");
    expect(contains(output, "abc123")).toBe(true);
    expect(contains(output, "videos")).toBe(true);
  });

  it("/artifacts lists artifacts", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", artifacts: [{ kind: "notes", videoId: "v1", modelRole: "cheap" }] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/artifacts");
    expect(contains(output, "notes")).toBe(true);
  });

  it("/notes warns when missing", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", artifacts: [] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/notes");
    expect(contains(output, "No notes")).toBe(true);
  });

  it("/quit returns to command mode", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com" });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/quit");
    expect(contains(output, "Left chat")).toBe(true);
    expect(session.getState().mode).toBe("command");
  });

  it("/play shows video link", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://youtube.com/watch?v=xyz123", videos: [{ id: "xyz123" }] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/play");
    expect(contains(output, "youtube.com")).toBe(true);
  });

  it("/video errors when no course", async () => {
    const session = makeTuiSession(fakeCtx());
    const output = await lines(session, "/video");
    expect(contains(output, "No course")).toBe(true);
  });

  it("/video errors when no video", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com" });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/video");
    expect(contains(output, "No video")).toBe(true);
  });

  it("/video plays with auto-detected backend", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://youtube.com/watch?v=xyz123", videos: [{ id: "xyz123" }] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/video");
    expect(contains(output, "Playing with browser")).toBe(true);
    expect(contains(output, "browser")).toBe(true);
  });

  it("/video respects --backend flag", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://youtube.com/watch?v=xyz123", videos: [{ id: "xyz123" }] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/video --backend=tct");
    expect(contains(output, "Playing with tct")).toBe(true);
    expect(contains(output, "tct")).toBe(true);
  });

  it("/video parses timestamp argument", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://youtube.com/watch?v=xyz123", videos: [{ id: "xyz123" }] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/video 2:30");
    expect(contains(output, "Playing with browser")).toBe(true);
  });

  it("/video combines timestamp and backend flag", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://youtube.com/watch?v=xyz123", videos: [{ id: "xyz123" }] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/video 1:05 --backend=kitty");
    expect(contains(output, "Playing with kitty")).toBe(true);
  });

  it("/stop reports nothing playing when idle", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com" });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/stop");
    expect(contains(output, "Nothing playing")).toBe(true);
  });

  it("/stop stops active playback", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://youtube.com/watch?v=xyz123", videos: [{ id: "xyz123" }] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    await lines(session, "/video");
    const output = await lines(session, "/stop");
    expect(contains(output, "Stopped")).toBe(true);
  });
});

describe("TUI commands", () => {
  it("help shows commands", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "help");
    expect(contains(output, "Commands:")).toBe(true);
  });

  it("config shows API key status", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "config");
    expect(contains(output, "OPENAI_API_KEY")).toBe(true);
  });

  it("delete removes course", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com" });
    const output = await lines(makeTuiSession(ctx), "delete abc123");
    expect(contains(output, "Deleted")).toBe(true);
    expect(ctx.loadSavedCourse("abc123")).toBeUndefined();
  });

  it("courses lists saved", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("a", {});
    ctx.saveCourse("b", {});
    const output = await lines(makeTuiSession(ctx), "courses");
    expect(contains(output, "a")).toBe(true);
    expect(contains(output, "b")).toBe(true);
  });

  it("resolve sets state", async () => {
    const session = makeTuiSession(fakeCtx());
    await lines(session, "resolve https://youtube.com/watch?v=abc123");
    expect(session.getState().currentCourse).toBe("resolved-123");
  });

  it("process switches to chat mode", async () => {
    const ctx = fakeCtx({
      processFactory: async () => ({ courseId: "proc-1", url: "https://...", artifactCount: 1, artifactKinds: ["notes"], modelRole: "cheap" }),
    });
    const session = makeTuiSession(ctx);
    const output = await lines(session, "process https://youtube.com/watch?v=abc123");
    expect(contains(output, "Chat mode active")).toBe(true);
    expect(session.getState().mode).toBe("chat");
    expect(session.getState().currentCourse).toBe("proc-1");
  });
});

describe("TUI transcript", () => {
  it("shows transcript from URL", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "transcript https://youtube.com/watch?v=abc123");
    expect(contains(output, "available")).toBe(true);
    expect(contains(output, "Hello world")).toBe(true);
  });

  it("shows saved transcript when no URL", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", {
      url: "https://example.com",
      transcripts: [{
        videoId: "v1", status: "available",
        provenance: { provider: "yt-dlp", language: "en", captionKind: "auto" },
        segments: [{ id: "s1", videoId: "v1", startSeconds: 0, endSeconds: 2, text: "Saved text" }],
      }],
    });
    const output = await lines(makeTuiSession(ctx, { currentCourse: "abc123" }), "transcript");
    expect(contains(output, "Saved text")).toBe(true);
  });
});

describe("HTML Artifacts", () => {
  it("generates flashcards HTML", () => {
    const html = generateHtmlArtifact("flashcards", "Test", {
      cards: [{ front: "Q1?", back: "A1", tags: ["ai"] }],
    });
    expect(html).toContain("Q1?");
    expect(html).toContain("A1");
    expect(html).toContain("<style>");
  });

  it("generates notes HTML", () => {
    const html = generateHtmlArtifact("notes", "Notes", {
      sections: [{ heading: "Intro", content: "Body", keyPoints: ["P1"] }],
    });
    expect(html).toContain("Intro");
    expect(html).toContain("P1");
  });

  it("generates player HTML", () => {
    const html = generateHtmlArtifact("player", "Player", { videoId: "abc123", startSeconds: 120, videoTitle: "Test" });
    expect(html).toContain("youtube.com/embed/abc123");
    expect(html).toContain("start=120");
  });
});

describe("TUI state transitions", () => {
  it("process sets course and ask uses it", async () => {
    const ctx = fakeCtx({
      processFactory: async () => ({ courseId: "state-test", url: "https://...", artifactCount: 1, artifactKinds: ["notes"], modelRole: "cheap" }),
      loadSavedCourse: (id) => id === "state-test" ? { chunks: [{ id: "c1", videoId: "v1", startSeconds: 0, endSeconds: 1, text: "hi" }], artifacts: [] } : undefined,
      llmFactory: () => ({ async generateStructured() { return { answer: "ok", status: "answered", citations: [{ videoId: "v1", startSeconds: 0, endSeconds: 1, chunkId: "c1", text: "hi" }], replayRanges: [], followUpQuestions: [], confidence: { score: 1, reason: "test" } }; } }),
    });

    const session = makeTuiSession(ctx);
    await lines(session, "process https://example.com");
    expect(session.getState().currentCourse).toBe("state-test");

    const askOutput = await lines(session, "what is this?");
    expect(contains(askOutput, "ok")).toBe(true);
  });
});
