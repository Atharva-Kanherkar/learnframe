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
  generateHtmlArtifact,
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
      htmlPath: `${outputDir ?? "/tmp/exports"}/${courseId}.html`,
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

function userBubble(text: string): string[] {
  return chatBubble("You", C.brightGreen, [text]);
}

function hasLine(output: string[], text: string): boolean {
  return output.some((line) => stripAnsi(line).includes(text));
}

describe("TUI modes", () => {
  it("starts in command mode", async () => {
    const session = makeTuiSession(fakeCtx());
    expect(session.getState().mode).toBe("command");
  });

  it("switches to chat mode when course is loaded", async () => {
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

describe("TUI chat mode", () => {
  it("treats plain text as a question in chat mode", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { 
      url: "https://example.com", 
      chunks: [{ id: "c1", videoId: "v1", startSeconds: 0, endSeconds: 10, text: "content" }], 
      artifacts: [] 
    });
    ctx.llmFactory = () => ({
      async generateStructured() {
        return {
          answer: "This is the answer.",
          status: "answered",
          citations: [{ videoId: "v1", startSeconds: 0, endSeconds: 10, chunkId: "c1", text: "content" }],
          replayRanges: [],
          followUpQuestions: [],
          confidence: { score: 0.9, reason: "grounded" },
        };
      },
    });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "what is this course about?");
    
    // Should show user bubble first
    expect(hasLine(output, "what is this course about?")).toBe(true);
    // Should show assistant response
    expect(hasLine(output, "This is the answer.")).toBe(true);
  });

  it("does NOT treat plain text as ask in command mode", async () => {
    const session = makeTuiSession(fakeCtx());
    const output = await lines(session, "what is this?");
    expect(hasLine(output, "Unknown command: what")).toBe(true);
  });

  it("shows help with slash commands in chat mode", async () => {
    const session = makeTuiSession(fakeCtx(), { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "help");
    expect(hasLine(output, "/notes")).toBe(true);
    expect(hasLine(output, "/flashcards")).toBe(true);
    expect(hasLine(output, "infographic")).toBe(true);
    expect(hasLine(output, "/export")).toBe(true);
  });
});

describe("TUI slash commands", () => {
  it("/status shows course status in chat mode", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", videos: [{ id: "v1" }], chunks: [{ id: "c1" }], artifacts: [{ kind: "notes" }], createdAt: "2026-01-01", sync: { added: ["v1"], updated: [], skipped: [] } });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/status");
    expect(hasLine(output, "abc123")).toBe(true);
    expect(hasLine(output, "Videos: 1")).toBe(true);
  });

  it("/artifacts lists artifacts in chat mode", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", artifacts: [{ kind: "notes", videoId: "v1", modelRole: "cheap" }] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/artifacts");
    expect(hasLine(output, "notes — v1 (cheap)")).toBe(true);
  });

  it("/export works in chat mode", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", artifacts: [] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/export");
    expect(hasLine(output, "Exported abc123")).toBe(true);
    expect(hasLine(output, ".json")).toBe(true);
  });

  it("/notes warns when no artifact exists", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", artifacts: [] });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/notes");
    expect(hasLine(output, "No notes artifact found")).toBe(true);
  });

  it("/quit switches back to command mode", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com" });
    const session = makeTuiSession(ctx, { currentCourse: "abc123", mode: "chat" });
    const output = await lines(session, "/quit");
    expect(hasLine(output, "command mode")).toBe(true);
    expect(session.getState().mode).toBe("command");
  });
});

describe("TUI help and navigation", () => {
  let session: TuiSession;

  beforeEach(() => {
    session = makeTuiSession(fakeCtx());
  });

  it("shows all commands on help", async () => {
    const output = await lines(session, "help");
    expect(output).toContain(title("LearnFrame — Claude Code for YouTube"));
    expect(hasLine(output, "CHAT MODE")).toBe(true);
    expect(hasLine(output, "COMMAND MODE")).toBe(true);
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
    expect(await lines(session, "courses")).toEqual([info("No saved courses")]);
  });

  it("shows current URL or no course loaded", async () => {
    expect(await lines(session, "url")).toEqual([info("No course loaded")]);
  });
});

describe("TUI config", () => {
  it("shows API key status", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "config");
    expect(output).toEqual(respond([title("Config"), badge("OPENAI_API_KEY:", "set")]));
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
    expect(session.getState().mode).toBe("command");
  });
});

describe("TUI resolve", () => {
  it("resolves URL and sets state", async () => {
    const session = makeTuiSession(fakeCtx());
    const output = await lines(session, "resolve https://youtube.com/watch?v=abc123");
    expect(hasLine(output, "Resolved: 1 video(s)")).toBe(true);
    expect(session.getState().currentCourse).toBe("resolved-123");
  });
});

describe("TUI transcript", () => {
  it("shows transcript status and preview", async () => {
    const output = await lines(makeTuiSession(fakeCtx()), "transcript https://youtube.com/watch?v=abc123");
    expect(output[0]).toBe(paint(C.dim, "Extracting transcript..."));
    expect(hasLine(output, "Status: available — 1 segments")).toBe(true);
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
    const output = await lines(makeTuiSession(ctx, { currentCourse: "abc123" }), "transcript");
    expect(hasLine(output, "Status: available — 1 segments")).toBe(true);
  });
});

describe("TUI course management", () => {
  it("loads a saved course and switches to chat mode", async () => {
    const ctx = fakeCtx();
    ctx.saveCourse("abc123", { url: "https://example.com", chunkCount: 10, artifacts: [{ kind: "notes" }, { kind: "summary" }] });
    const session = makeTuiSession(ctx);
    const output = await lines(session, "course abc123");
    expect(hasLine(output, "Loaded")).toBe(true);
    expect(hasLine(output, "CHAT")).toBe(true);
    expect(session.getState().currentCourse).toBe("abc123");
    expect(session.getState().mode).toBe("chat");
  });
});

describe("TUI process", () => {
  it("processes a URL and switches to chat mode", async () => {
    const saved: Record<string, any> = {};
    const ctx = fakeCtx({
      saveCourse: (id, state) => { saved[id] = state; },
      processFactory: async () => ({ courseId: "proc-1", url: "https://...", artifactCount: 3, artifactKinds: ["notes"], modelRole: "cheap" }),
    });
    const session = makeTuiSession(ctx);
    const output = await lines(session, "process https://youtube.com/watch?v=abc123 --outputs notes");

    expect(hasLine(output, "Done!")).toBe(true);
    expect(hasLine(output, "Chat mode activated")).toBe(true);
    expect(session.getState().currentCourse).toBe("proc-1");
    expect(session.getState().mode).toBe("chat");
  });
});

describe("HTML Artifact Generator", () => {
  it("generates flashcards HTML", () => {
    const html = generateHtmlArtifact("flashcards", "Test Cards", {
      cards: [
        { front: "What is AI?", back: "Artificial Intelligence", tags: ["tech", "ai"] },
        { front: "What is ML?", back: "Machine Learning" },
      ],
    });
    expect(html).toContain("What is AI?");
    expect(html).toContain("Artificial Intelligence");
    expect(html).toContain("<style>");
    expect(html).toContain("flashcard");
  });

  it("generates notes HTML", () => {
    const html = generateHtmlArtifact("notes", "Study Notes", {
      sections: [
        { heading: "Introduction", content: "This is content", keyPoints: ["Point 1", "Point 2"] },
      ],
    });
    expect(html).toContain("Introduction");
    expect(html).toContain("Point 1");
  });

  it("generates infographic HTML", () => {
    const html = generateHtmlArtifact("infographic", "Stats", {
      stats: { "Videos": 5, "Chunks": 42 },
      items: [{ title: "Key Concept", description: "Important idea" }],
    });
    expect(html).toContain("Videos");
    expect(html).toContain("42");
    expect(html).toContain("Key Concept");
  });
});
