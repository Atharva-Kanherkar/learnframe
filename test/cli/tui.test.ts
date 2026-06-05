import { describe, expect, it, beforeEach } from "vitest";
import {
  makeTuiSession,
  C,
  paint,
  ok,
  fail,
  warn,
  info,
  bullet,
  numbered,
  badge,
  title,
  hr,
  chatBubble,
  stripAnsi,
} from "../../src/cli/tui.js";
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
    deleteCourse: (id) => { delete saved[id]; },
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
    processFactory: async (url, apiKey, outputs, useWhisper) => ({
      courseId: "processed-123",
      url,
      artifactCount: 3,
      artifactKinds: ["notes", "summary", "syllabus"],
      modelRole: "cheap",
    }),
    exportFactory: async (courseId, outputDir) => ({
      courseId,
      jsonPath: `${outputDir ?? "/tmp/exports"}/${courseId}.json`,
      markdownPath: `${outputDir ?? "/tmp/exports"}/${courseId}.md`,
    }),
    ...overrides,
  };
}

function lines(session: TuiSession, input: string): Promise<string[]> {
  return session.handle(input).then((r) => r.lines);
}

function respond(lines: string[]): string[] {
  return chatBubble("LearnFrame", C.brightCyan, lines);
}

function hasLine(output: string[], text: string): boolean {
  return output.some((line) => stripAnsi(line).includes(text));
}

describe("TUI help and navigation", () => {
  let session: TuiSession;

  beforeEach(() => {
    session = makeTuiSession(fakeCtx());
  });

  it("shows all commands on help", async () => {
    const output = await lines(session, "help");
    expect(output).toContain(title("LearnFrame TUI Commands"));
    expect(output).toContain(bullet("process <url> [--outputs kind,...] [--whisper]"));
    expect(output).toContain(bullet("ask <question>                     Ask about loaded course"));
    expect(output).toContain(bullet("resolve <url>                      Resolve YouTube URL"));
    expect(output).toContain(bullet("course <id>                        Load a saved course"));
    expect(output).toContain(bullet("courses                            List saved courses"));
    expect(output).toContain(bullet("exit                               Quit"));
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
    expect(await lines(session, "courses")).toEqual(respond([info("No saved courses")]));
  });

  it("shows current URL or no course loaded", async () => {
    expect(await lines(session, "url")).toEqual([info("No course loaded")]);
  });

  it("shows error for unknown command with no course loaded", async () => {
    expect(await lines(session, "blah")).toEqual([warn("Unknown command: blah. Type 'help' for commands.")]);
  });

  it("suggests ask for unknown command when course is loaded", async () => {
    const s = makeTuiSession(fakeCtx(), { currentCourse: "abc123", currentUrl: "https://..." });
    expect(await lines(s, "blah")).toEqual([warn('Unknown command "blah". To ask a question use: ask blah')]);
  });
});

describe("TUI config", () => {
  it("shows API key status", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "config");
    expect(output).toEqual(respond([title("Config"), badge("OPENAI_API_KEY:", "set")]));
  });

  it("shows missing API key", async () => {
    const output = await lines(makeTuiSession(fakeCtx({ getApiKey: () => undefined })), "config");
    expect(output).toEqual(respond([title("Config"), badge("OPENAI_API_KEY:", "not set")]));
  });
});

describe("TUI delete", () => {
  it("deletes a saved course", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com" });
    const output = await lines(makeTuiSession(ctx), "delete abc123");
    expect(output).toContain(ok('Deleted "abc123"'));
    expect(ctx.loadSavedCourse("abc123")).toBeUndefined();
  });

  it("clears current course if deleted", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com" });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", currentUrl: "https://example.com" });
    await lines(session, "delete abc123");
    expect(session.getState().currentCourse).toBeUndefined();
  });

  it("shows usage for missing id", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "delete")).toEqual([warn("Usage: delete <id>")]);
  });
});

describe("TUI status", () => {
  it("shows course status", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", videos: [{ id: "v1" }], chunks: [{ id: "c1" }], artifacts: [{ kind: "notes" }], createdAt: "2026-01-01", sync: { added: ["v1"], updated: [], skipped: [] } });
    const output = await lines(makeTuiSession(ctx, { currentCourse: "abc123", currentUrl: "https://example.com" }), "status");
    expect(hasLine(output, "Course: abc123")).toBe(true);
    expect(hasLine(output, "Videos: 1")).toBe(true);
    expect(hasLine(output, "Artifacts: 1")).toBe(true);
  });

  it("warns when no course loaded", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "status")).toEqual([warn("No course loaded")]);
  });

  it("errors when course missing from disk", async () => {
    const output = await lines(makeTuiSession(fakeCtx(), { currentCourse: "missing", currentUrl: "https://..." }), "status");
    expect(output).toEqual([fail('Course "missing" not found')]);
  });
});

describe("TUI artifacts", () => {
  it("lists artifacts for current course", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", artifacts: [{ kind: "notes", videoId: "v1", modelRole: "cheap" }, { kind: "summary", modelRole: "medium" }] });
    const output = await lines(makeTuiSession(ctx, { currentCourse: "abc123" }), "artifacts");
    expect(hasLine(output, "Artifacts (2)")).toBe(true);
    expect(hasLine(output, "notes — v1 (cheap)")).toBe(true);
    expect(hasLine(output, "summary — course (medium)")).toBe(true);
  });

  it("shows empty artifacts message", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", artifacts: [] });
    const output = await lines(makeTuiSession(ctx, { currentCourse: "abc123" }), "artifacts");
    expect(output).toEqual(respond([info("No artifacts generated yet")]));
  });

  it("warns when no course loaded", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "artifacts")).toEqual([warn("No course loaded")]);
  });
});

describe("TUI resolve", () => {
  it("resolves URL and sets state", async () => {
    const session = makeTuiSession(fakeCtx());
    const output = await lines(session, "resolve https://youtube.com/watch?v=abc123");
    expect(hasLine(output, "Resolved: 1 video(s)")).toBe(true);
    expect(hasLine(output, "abc123 — Test Video")).toBe(true);
    expect(session.getState().currentCourse).toBe("resolved-123");
    expect(session.getState().currentUrl).toBe("https://youtube.com/watch?v=abc123");
  });

  it("shows usage for missing URL", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "resolve")).toEqual([warn("Usage: resolve <url>")]);
  });

  it("shows error on resolve failure", async () => {
    const session = makeTuiSession(fakeCtx({ resolveUrl: async () => { throw new Error("boom"); } }));
    expect(await lines(session, "resolve https://example.com")).toEqual([fail("Error: boom")]);
  });
});

describe("TUI transcript", () => {
  it("shows transcript status and preview", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "transcript https://youtube.com/watch?v=abc123");
    expect(output[0]).toBe(paint(C.dim, "Extracting transcript..."));
    expect(hasLine(output, "Status: available — 1 segments")).toBe(true);
    expect(hasLine(output, "Source: yt-dlp / en / auto")).toBe(true);
    expect(output.some((l) => l.includes("Hello world"))).toBe(true);
  });

  it("shows usage for missing URL", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "transcript")).toEqual([warn("Usage: transcript <url> [--whisper] or load a course first")]);
  });

  it("propagates transcript errors", async () => {
    const session = makeTuiSession(fakeCtx({ transcriptFactory: async () => { throw new Error("timeout"); } }));
    const output = await lines(session, "transcript https://example.com");
    expect(output[0]).toBe(paint(C.dim, "Extracting transcript..."));
    expect(output[1]).toBe(fail("Error: timeout"));
  });

  it("shows saved transcript when no URL provided and course loaded", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", {
      url: "https://example.com",
      transcripts: [{
        videoId: "v1",
        status: "available",
        provenance: { provider: "yt-dlp", language: "en", captionKind: "auto" },
        segments: [{ id: "s1", videoId: "v1", startSeconds: 0, endSeconds: 2, text: "Saved text" }],
      }],
    });
    const output = await lines(makeTuiSession(ctx, { currentCourse: "abc123", currentUrl: "https://example.com" }), "transcript");
    expect(hasLine(output, "Status: available — 1 segments")).toBe(true);
    expect(output.some((l) => l.includes("Saved text"))).toBe(true);
  });
});

describe("TUI course management", () => {
  it("loads a saved course", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", chunkCount: 10, artifacts: [{ kind: "notes" }, { kind: "summary" }] });
    const session = makeTuiSession(ctx);
    const output = await lines(session, "course abc123");
    expect(output).toEqual([ok("Loaded abc123 — 10 chunks, 2 artifacts")]);
    expect(session.getState().currentCourse).toBe("abc123");
    expect(session.getState().currentUrl).toBe("https://example.com");
  });

  it("shows error for missing course", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "course missing")).toEqual([fail('Course "missing" not found')]);
  });

  it("lists saved courses", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("a", {});
    ctx.saveCourse("b", {});
    expect(await lines(makeTuiSession(ctx), "courses")).toEqual(respond([numbered(1, "a"), numbered(2, "b")]));
  });

  it("shows usage for course without id", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "course")).toEqual([warn("Usage: course <id>")]);
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

    expect(output[0]).toBe(paint(C.dim, "Extracting transcript..."));
    expect(hasLine(output, "Done! 3 artifacts generated")).toBe(true);
    expect(hasLine(output, "notes (cheap)")).toBe(true);
    expect(hasLine(output, "SAVED:proc-1")).toBe(true);
    expect(session.getState().currentCourse).toBe("proc-1");
  });

  it("complains about missing API key", async () => {
    const session = makeTuiSession(fakeCtx({ getApiKey: () => undefined }));
    expect(await lines(session, "process https://example.com")).toEqual([fail("OPENAI_API_KEY not set")]);
  });

  it("shows usage for missing URL", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "process")).toEqual([warn("Usage: process <url> [--outputs notes,summary] [--whisper]")]);
  });

  it("shows error when transcript unavailable", async () => {
    const session = makeTuiSession(fakeCtx({
      processFactory: async () => { throw new Error("Transcript unavailable"); },
    }));
    const output = await lines(session, "process https://example.com");
    expect(output[0]).toBe(paint(C.dim, "Extracting transcript..."));
    expect(output[1]).toBe(fail("Error: Transcript unavailable"));
  });
});

describe("TUI ask", () => {
  it("complains when no course is loaded", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "ask what is this?")).toEqual([warn("No course loaded. Run 'process <url>' or 'course <id>' first.")]);
  });

  it("complains about missing API key", async () => {
    const session = makeTuiSession(fakeCtx({ getApiKey: () => undefined }), { currentCourse: "abc123", currentUrl: "https://..." });
    expect(await lines(session, "ask what?")).toEqual([fail("OPENAI_API_KEY not set")]);
  });

  it("shows usage for missing question", async () => {
    const session = makeTuiSession(fakeCtx(), { currentCourse: "abc123", currentUrl: "https://..." });
    expect(await lines(session, "ask")).toEqual([warn("Usage: ask <question>")]);
  });

  it("shows error when course state is missing from disk", async () => {
    const session = makeTuiSession(fakeCtx(), { currentCourse: "missing", currentUrl: "https://..." });
    expect(await lines(session, "ask what?")).toEqual([fail('Course "missing" not found on disk.')]);
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
    expect(output).toEqual(respond(["I don't know", `  ${paint(C.dim, "(reason: no context)")}`]));
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

    expect(hasLine(output, "It means this.")).toBe(true);
    expect(hasLine(output, "Citations (1)")).toBe(true);
    expect(hasLine(output, "v1 [00:00:00-00:00:10]")).toBe(true);
    expect(hasLine(output, "Replay")).toBe(true);
    expect(hasLine(output, "Follow-ups")).toBe(true);
    expect(hasLine(output, "What else?")).toBe(true);
  });
});

describe("TUI export", () => {
  it("exports current loaded course", async () => {
    const session = makeTuiSession(fakeCtx(), { currentCourse: "abc123", currentUrl: "https://..." });
    const output = await lines(session, "export");

    expect(output).toEqual(respond([
      ok("Exported abc123"),
      badge("JSON:", "/tmp/exports/abc123.json"),
      badge("Markdown:", "/tmp/exports/abc123.md"),
    ]));
  });

  it("exports explicit course id to a custom directory", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "export my-course --dir /tmp/out");
    expect(output).toEqual(respond([
      ok("Exported my-course"),
      badge("JSON:", "/tmp/out/my-course.json"),
      badge("Markdown:", "/tmp/out/my-course.md"),
    ]));
  });

  it("shows usage when no course id is available", async () => {
    expect(await lines(makeTuiSession(fakeCtx()), "export")).toEqual([warn("Usage: export [courseId] [--dir path]")]);
  });

  it("surfaces export errors", async () => {
    const session = makeTuiSession(fakeCtx({ exportFactory: async () => { throw new Error("disk full"); } }), { currentCourse: "abc123", currentUrl: "https://..." });
    expect(await lines(session, "export")).toEqual([fail("Error: disk full")]);
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
    expect(hasLine(askOutput, "ok")).toBe(true);
  });

  it("resolve sets course and url translates", async () => {
    const session = makeTuiSession(fakeCtx());
    await lines(session, "resolve https://youtube.com/watch?v=xyz");
    expect(session.getState().currentCourse).toBe("resolved-123");
    expect(await lines(session, "url")).toEqual([badge("URL:", "https://youtube.com/watch?v=xyz")]);
  });

  it("course command loads from saved state", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("my-course", { url: "https://saved.example", chunkCount: 5, artifacts: [] });
    const session = makeTuiSession(ctx);
    await lines(session, "course my-course");
    expect(session.getState().currentUrl).toBe("https://saved.example");
  });
});
