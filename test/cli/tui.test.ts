import { describe, expect, it, beforeEach } from "vitest";
import { makeTuiSession, C, colored } from "../../src/cli/tui.js";
import type { TuiContext, TuiSession } from "../../src/cli/tui.js";

function fakeCtx(overrides: Partial<TuiContext> = {}): TuiContext {
  const saved: Record<string, any> = {};
  return {
    courseDir: "/tmp/.learnframe/courses",
    getApiKey: () => "test-api-key",
    now: () => new Date("2026-01-01"),
    listSavedCourses: () => Object.keys(saved),
    loadSavedCourse: (id) => saved[id],
    saveCourse: (id, state) => { saved[id] = state; },
    resolveUrl: async (url) => ({
      courseId: "resolved-123",
      videos: [{ id: "abc123", title: "Test Video" }],
    }),
    llmFactory: () => ({
      async generateStructured(req: any) {
        return { fake: "llm-response", task: req.task };
      },
    }),
    transcriptFactory: async () => ({
      status: "available",
      segments: [{ id: "s1", videoId: "v1", startSeconds: 0, endSeconds: 2, text: "Hello world" }],
      provenance: { provider: "yt-dlp", language: "en", captionKind: "auto" },
    }),
    processFactory: async (url, apiKey, outputs) => ({
      courseId: "processed-123",
      url,
      artifactCount: 3,
      artifactKinds: ["notes", "summary", "syllabus"],
      modelRole: "cheap",
    }),
    ...overrides,
  };
}

function lines(session: TuiSession, input: string): Promise<string[]> {
  return session.handle(input).then((r) => r.lines);
}

describe("TUI help and navigation", () => {
  let session: TuiSession;

  beforeEach(() => {
    session = makeTuiSession(fakeCtx());
  });

  it("shows all commands on help", async () => {
    const output = await lines(session, "help");
    expect(output).toContain("process <url> [--outputs kind,...]   Full pipeline: captions → chunks → artifacts → save");
    expect(output).toContain("ask <question>                     Ask about loaded course (timestamp citations)");
    expect(output).toContain("resolve <url>                      Resolve YouTube URL to metadata");
    expect(output).toContain("transcript <url> [--whisper]       Extract captions or transcribe");
    expect(output).toContain("course <id>                        Load a saved course");
    expect(output).toContain("courses                            List saved courses");
    expect(output).toContain("exit                               Quit");
  });

  it("returns empty lines for blank input", async () => {
    expect(await lines(session, "")).toEqual([]);
    expect(await lines(session, "   ")).toEqual([]);
  });

  it("shows exit signal on exit command", async () => {
    expect(await lines(session, "exit")).toEqual(["exit"]);
    expect(await lines(session, "quit")).toEqual(["exit"]);
  });

  it("shows no saved courses", async () => {
    expect(await lines(session, "courses")).toEqual(["No saved courses"]);
  });

  it("shows current URL or no course loaded", async () => {
    expect(await lines(session, "url")).toEqual(["No course loaded"]);
  });

  it("shows error for unknown command with no course loaded", async () => {
    expect(await lines(session, "blah")).toEqual(["Unknown command: blah. Type 'help' for commands."]);
  });

  it("suggests ask for unknown command when course is loaded", async () => {
    const s = makeTuiSession(fakeCtx(), { currentCourse: "abc123", currentUrl: "https://..." });
    expect(await lines(s, "blah")).toEqual(['Unknown command "blah". To ask a question use: ask blah']);
  });
});

describe("TUI resolve", () => {
  it("resolves URL and sets state", async () => {
    const session = makeTuiSession(fakeCtx());
    const output = await lines(session, "resolve https://youtube.com/watch?v=abc123");
    expect(output).toContain("Resolved: 1 video(s)");
    expect(output).toContain("abc123 — Test Video");
    expect(session.getState().currentCourse).toBe("resolved-123");
    expect(session.getState().currentUrl).toBe("https://youtube.com/watch?v=abc123");
  });

  it("shows usage for missing URL", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "resolve");
    expect(output).toEqual(["Usage: resolve <url>"]);
  });

  it("shows error on resolve failure", async () => {
    const session = makeTuiSession(fakeCtx({ resolveUrl: async () => { throw new Error("boom"); } }));
    expect(await lines(session, "resolve https://example.com")).toEqual(["Error: boom"]);
  });
});

describe("TUI transcript", () => {
  it("shows transcript status and preview", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "transcript https://youtube.com/watch?v=abc123");
    expect(output).toContain("Extracting transcript...");
    expect(output).toContain("Status: available — 1 segments");
    expect(output).toContain("yt-dlp / en / auto");
    expect(output[3]).toContain("Hello world");
  });

  it("shows usage for missing URL", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "transcript")).toEqual(["Usage: transcript <url> [--whisper]"]);
  });

  it("propagates transcript errors", async () => {
    const session = makeTuiSession(fakeCtx({ transcriptFactory: async () => { throw new Error("timeout"); } }));
    expect(await lines(session, "transcript https://example.com")).toEqual(["Extracting transcript...", "Error: timeout"]);
  });
});

describe("TUI course management", () => {
  it("loads a saved course", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", chunkCount: 10, artifacts: [{ kind: "notes" }, { kind: "summary" }] });
    const session = makeTuiSession(ctx);
    const output = await lines(session, "course abc123");
    expect(output).toEqual(["Loaded abc123 — 10 chunks, 2 artifacts"]);
    expect(session.getState().currentCourse).toBe("abc123");
    expect(session.getState().currentUrl).toBe("https://example.com");
  });

  it("shows error for missing course", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "course missing")).toEqual(['Course "missing" not found']);
  });

  it("lists saved courses", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("a", {});
    ctx.saveCourse("b", {});
    expect(await lines(makeTuiSession(ctx), "courses")).toEqual(["a", "b"]);
  });

  it("shows usage for course without id", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "course")).toEqual(["Usage: course <id>"]);
  });
});

describe("TUI process", () => {
  it("processes a URL and saves state", async () => {
    const saved: Record<string, any> = {};
    const ctx = fakeCtx({
      saveCourse: (id, state) => { saved[id] = state; },
      processFactory: async () => ({ courseId: "proc-1", url: "https://...", artifactCount: 3, artifactKinds: ["notes"], modelRole: "cheap" }),
    });
    const session = makeTuiSession(ctx);
    const output = await lines(session, "process https://youtube.com/watch?v=abc123 --outputs notes");

    expect(output).toContain("Extracting transcript...");
    expect(output).toContain("Done! 3 artifacts generated.");
    expect(output).toContain("SAVED:proc-1");
    expect(session.getState().currentCourse).toBe("proc-1");
  });

  it("complains about missing API key", async () => {
    const session = makeTuiSession(fakeCtx({ getApiKey: () => undefined }));
    expect(await lines(session, "process https://example.com")).toEqual(["OPENAI_API_KEY not set"]);
  });

  it("shows usage for missing URL", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "process")).toEqual(["Usage: process <url> [--outputs notes,summary]"]);
  });

  it("shows error when transcript unavailable", async () => {
    const session = makeTuiSession(fakeCtx({
      processFactory: async () => { throw new Error("Transcript unavailable"); },
    }));
    expect(await lines(session, "process https://example.com")).toEqual(["Extracting transcript...", "Error: Transcript unavailable"]);
  });
});

describe("TUI ask", () => {
  it("complains when no course is loaded", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "ask what is this?")).toEqual([
      "No course loaded. Run 'process <url>' or 'course <id>' first.",
    ]);
  });

  it("complains about missing API key", async () => {
    const session = makeTuiSession(fakeCtx({ getApiKey: () => undefined }), { currentCourse: "abc123", currentUrl: "https://..." });
    expect(await lines(session, "ask what?")).toEqual(["OPENAI_API_KEY not set"]);
  });

  it("shows usage for missing question", async () => {
    const session = makeTuiSession(fakeCtx(), { currentCourse: "abc123", currentUrl: "https://..." });
    expect(await lines(session, "ask")).toEqual(["Usage: ask <question>"]);
  });

  it("shows error when course state is missing from disk", async () => {
    const session = makeTuiSession(fakeCtx(), { currentCourse: "missing", currentUrl: "https://..." });
    expect(await lines(session, "ask what?")).toEqual(['Course "missing" not found on disk.']);
  });

  it("shows insufficient context answer", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://...", chunks: [{ id: "c1", videoId: "v1", startSeconds: 0, endSeconds: 1, text: "hello" }], artifacts: [] });
    ctx.llmFactory = () => ({
      async generateStructured() {
        return { answer: "I don't know", status: "insufficient_context", citations: [], replayRanges: [], followUpQuestions: [], confidence: { score: 0, reason: "no context" } };
      },
    });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", currentUrl: "https://..." });
    const output = await lines(session, "ask what is this?");
    expect(output).toEqual(["I don't know", "(reason: no context)"]);
  });

  it("returns grounded answer with citations and follow-ups", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://...", chunks: [{ id: "c1", videoId: "v1", startSeconds: 0, endSeconds: 10, text: "content" }], artifacts: [] });
    ctx.llmFactory = () => ({
      async generateStructured() {
        return {
          answer: "It means this.",
          status: "answered",
          citations: [{ videoId: "v1", startSeconds: 0, endSeconds: 10, chunkId: "c1", text: "content" }],
          replayRanges: [{ videoId: "v1", startSeconds: 0, endSeconds: 10 }],
          followUpQuestions: ["What else?"],
          confidence: { score: 0.9, reason: "grounded" },
        };
      },
    });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", currentUrl: "https://..." });
    const output = await lines(session, "ask what is this?");

    expect(output).toContain("It means this.");
    expect(output).toContain("Citations (1):");
    expect(output).toContain("  v1 [00:00:00-00:00:10]");
    expect(output).toContain("Replay:");
    expect(output).toContain("Follow-ups:");
    expect(output).toContain("  - What else?");
  });
});

describe("TUI state transitions", () => {
  it("process sets course and ask uses it", async () => {
    const ctx = fakeCtx({
      processFactory: async () => ({ courseId: "state-test", url: "https://...", artifactCount: 1, artifactKinds: ["notes"], modelRole: "cheap" }),
      saveCourse: () => {},
      loadSavedCourse: (id) => id === "state-test" ? { chunks: [{ id: "c1", videoId: "v1", startSeconds: 0, endSeconds: 1, text: "hi" }], artifacts: [] } : undefined,
      llmFactory: () => ({ async generateStructured() { return { answer: "ok", status: "answered", citations: [{ videoId: "v1", startSeconds: 0, endSeconds: 1, chunkId: "c1", text: "hi" }], replayRanges: [], followUpQuestions: [], confidence: { score: 1, reason: "test" } }; } }),
    });

    const session = makeTuiSession(ctx);
    await lines(session, "process https://example.com --outputs notes");
    expect(session.getState().currentCourse).toBe("state-test");

    const askOutput = await lines(session, "ask what is this?");
    expect(askOutput).toContain("ok");
  });

  it("resolve sets course and url translates", async () => {
    const session = makeTuiSession(fakeCtx());
    await lines(session, "resolve https://youtube.com/watch?v=xyz");
    expect(session.getState().currentCourse).toBe("resolved-123");
    expect(await lines(session, "url")).toEqual(["https://youtube.com/watch?v=xyz"]);
  });

  it("course command loads from saved state", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("my-course", { url: "https://saved.example", chunkCount: 5, artifacts: [] });
    const session = makeTuiSession(ctx);
    await lines(session, "course my-course");
    expect(session.getState().currentUrl).toBe("https://saved.example");
  });
});
