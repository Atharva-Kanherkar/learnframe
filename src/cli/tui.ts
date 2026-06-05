import * as readline from "node:readline";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseYoutubeUrl, createInMemorySourceResolver, createInMemoryStorage, createLearnFrame } from "../index.js";
import { buildExportPackResult } from "../export/pack.js";
import type { CourseProcessingState, Transcript, StorageAdapter, ArtifactKind } from "../contracts.js";

// ---------------------------------------------------------------------------
// ANSI palette (expanded)
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
// HTML Artifact Generator
// ---------------------------------------------------------------------------
export function generateHtmlArtifact(type: string, title: string, content: any): string {
  const styles = `
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; background: #0f172a; color: #e2e8f0; }
      h1 { color: #38bdf8; border-bottom: 2px solid #38bdf8; padding-bottom: 10px; }
      h2 { color: #818cf8; margin-top: 30px; }
      .card { background: #1e293b; border-radius: 12px; padding: 20px; margin: 15px 0; border-left: 4px solid #38bdf8; }
      .flashcard { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); border-radius: 16px; padding: 30px; margin: 20px 0; border: 2px solid #475569; }
      .flashcard-front { font-size: 1.3em; font-weight: 600; color: #fbbf24; margin-bottom: 15px; }
      .flashcard-back { color: #cbd5e1; line-height: 1.6; }
      .tag { display: inline-block; background: #38bdf8; color: #0f172a; padding: 4px 12px; border-radius: 20px; font-size: 0.85em; margin: 5px 5px 5px 0; font-weight: 600; }
      .timestamp { color: #94a3b8; font-size: 0.9em; }
      .highlight { background: rgba(56, 189, 248, 0.1); padding: 2px 6px; border-radius: 4px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin: 20px 0; }
      .metric { text-align: center; padding: 20px; background: #1e293b; border-radius: 12px; }
      .metric-value { font-size: 2em; font-weight: 700; color: #38bdf8; }
      .metric-label { color: #94a3b8; margin-top: 5px; }
    </style>
  `;

  let bodyContent = "";

  switch (type) {
    case "flashcards": {
      const cards = content.cards || [];
      bodyContent = `
        <h1>🎯 ${title}</h1>
        <div class="grid">
          <div class="metric">
            <div class="metric-value">${cards.length}</div>
            <div class="metric-label">Flashcards</div>
          </div>
        </div>
        ${cards.map((card: any, i: number) => `
          <div class="flashcard">
            <div class="flashcard-front">Q${i + 1}: ${card.front || card.question || "Question"}</div>
            <div class="flashcard-back">${card.back || card.answer || "Answer"}</div>
            ${card.tags ? `<div>${card.tags.map((t: string) => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
          </div>
        `).join("")}
      `;
      break;
    }
    case "notes": {
      const sections = content.sections || [];
      bodyContent = `
        <h1>📝 ${title}</h1>
        ${sections.map((section: any) => `
          <div class="card">
            <h2>${section.heading || "Section"}</h2>
            <p>${section.content || ""}</p>
            ${section.keyPoints ? `<ul>${section.keyPoints.map((p: string) => `<li>${p}</li>`).join("")}</ul>` : ""}
            ${section.timestamps ? `<div class="timestamp">⏱️ ${section.timestamps.join(", ")}</div>` : ""}
          </div>
        `).join("")}
      `;
      break;
    }
    case "infographic": {
      const stats = content.stats || {};
      const items = content.items || [];
      bodyContent = `
        <h1>📊 ${title}</h1>
        <div class="grid">
          ${Object.entries(stats).map(([key, value]) => `
            <div class="metric">
              <div class="metric-value">${value}</div>
              <div class="metric-label">${key}</div>
            </div>
          `).join("")}
        </div>
        ${items.map((item: any) => `
          <div class="card">
            <h2>${item.title || "Item"}</h2>
            <p>${item.description || ""}</p>
            ${item.tags ? `<div>${item.tags.map((t: string) => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
          </div>
        `).join("")}
      `;
      break;
    }
    default: {
      bodyContent = `
        <h1>📄 ${title}</h1>
        <div class="card">
          <pre>${JSON.stringify(content, null, 2)}</pre>
        </div>
      `;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${styles}
</head>
<body>
  ${bodyContent}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// TUI context and session types
// ---------------------------------------------------------------------------
export type TuiContext = {
  courseDir: string;
  llmFactory: (apiKey: string) => any;
  transcriptFactory: (url: string, apiKey: string | undefined, useWhisper: boolean) => Promise<any>;
  processFactory: (url: string, apiKey: string, outputs: string, useWhisper?: boolean) => Promise<any>;
  exportFactory: (courseId: string, outputDir?: string) => Promise<{ courseId: string; jsonPath: string; markdownPath: string; htmlPath?: string }>;
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
  mode: "command" | "chat";
  chatHistory: Array<{ role: "user" | "assistant"; text: string }>;
};

export type TuiOutput = { lines: string[]; state: TuiState };
export type TuiSession = {
  handle(line: string): Promise<TuiOutput>;
  getState(): TuiState;
};

export function makeTuiSession(ctx: TuiContext, initial: Partial<TuiState> = {}): TuiSession {
  const state: TuiState = {
    currentCourse: undefined,
    currentUrl: undefined,
    mode: initial.mode ?? (initial.currentCourse ? "chat" : "command"),
    chatHistory: initial.chatHistory ?? [],
    ...initial,
  };
  const llm: { instance: any | undefined } = { instance: undefined };

  const fmt = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  function respond(lines: string[]): string[] {
    return chatBubble("LearnFrame", C.brightCyan, lines);
  }

  function userBubble(text: string): string[] {
    return chatBubble("You", C.brightGreen, [text]);
  }

  async function handle(input: string): Promise<TuiOutput> {
    const lines: string[] = [];
    const trimmed = input.trim();
    if (!trimmed) return { lines: [], state };

    // Always show user input as a bubble in chat mode
    if (state.mode === "chat" && !trimmed.startsWith("/") && !trimmed.startsWith("!")) {
      lines.push(...userBubble(trimmed));
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rest = parts.slice(1);

    // Exit always works
    if (cmd === "exit" || cmd === "quit") { lines.push("exit"); return { lines, state }; }

    // Help
    if (cmd === "help" || cmd === "?") {
      lines.push(title("LearnFrame — Claude Code for YouTube"));
      lines.push(hr());
      lines.push(paint(C.bold, "CHAT MODE (when course is loaded):"));
      lines.push(bullet("Just type your question — no need for 'ask'"));
      lines.push(bullet("/notes — Generate visual study notes"));
      lines.push(bullet("/flashcards — Generate flashcards"));
      lines.push(bullet("/infographic — Generate data infographic"));
      lines.push(bullet("/export — Export course as JSON + Markdown + HTML"));
      lines.push(bullet("/status — Show course processing status"));
      lines.push(bullet("/artifacts — List all generated artifacts"));
      lines.push(bullet("/quit — Exit chat mode"));
      lines.push("");
      lines.push(paint(C.bold, "COMMAND MODE (when no course loaded):"));
      lines.push(bullet("process <url> [--outputs kind,...] [--whisper]"));
      lines.push(bullet("resolve <url> — Resolve YouTube URL"));
      lines.push(bullet("course <id> — Load a saved course"));
      lines.push(bullet("courses — List saved courses"));
      lines.push(bullet("delete <id> — Delete a saved course"));
      lines.push(bullet("config — Show configuration"));
      lines.push(bullet("help — Show this help"));
      lines.push(hr());
      return { lines, state };
    }

    // Config command
    if (cmd === "config") {
      const apiKey = ctx.getApiKey();
      lines.push(...respond([title("Config"), badge("OPENAI_API_KEY:", apiKey ? "set" : "not set")]));
      return { lines, state };
    }

    // Delete command
    if (cmd === "delete") {
      const id = rest[0];
      if (!id) { lines.push(warn("Usage: delete <id>")); return { lines, state }; }
      ctx.deleteCourse(id);
      lines.push(ok(`Deleted "${id}"`));
      if (state.currentCourse === id) {
        state.currentCourse = undefined;
        state.currentUrl = undefined;
        state.mode = "command";
        lines.push(info("Switched to command mode"));
      }
      return { lines, state };
    }

    // Status (works in both modes)
    if (cmd === "/status" || cmd === "status") {
      if (!state.currentCourse) { lines.push(warn("No course loaded")); return { lines, state }; }
      const s = ctx.loadSavedCourse(state.currentCourse);
      if (!s) { lines.push(fail(`Course "${state.currentCourse}" not found`)); return { lines, state }; }
      const videoCount = Array.isArray(s.videos) ? s.videos.length : 0;
      const chunkCount = s.chunkCount ?? (Array.isArray(s.chunks) ? s.chunks.length : 0);
      const artifactCount = Array.isArray(s.artifacts) ? s.artifacts.length : 0;
      const sync = s.sync ?? { added: [], updated: [], skipped: [] };
      lines.push(...respond([
        title(`📚 ${state.currentCourse}`),
        badge("URL:", s.url ?? "—"),
        badge("Videos:", String(videoCount)),
        badge("Chunks:", String(chunkCount)),
        badge("Artifacts:", String(artifactCount)),
        badge("Created:", s.createdAt ?? "—"),
        badge("Sync:", `${sync.added.length} added · ${sync.updated.length} updated · ${sync.skipped.length} skipped`),
      ]));
      return { lines, state };
    }

    // Artifacts list
    if (cmd === "/artifacts" || cmd === "artifacts") {
      if (!state.currentCourse) { lines.push(warn("No course loaded")); return { lines, state }; }
      const s = ctx.loadSavedCourse(state.currentCourse);
      if (!s) { lines.push(fail(`Course "${state.currentCourse}" not found`)); return { lines, state }; }
      const artifacts: any[] = s.artifacts ?? [];
      if (artifacts.length === 0) {
        lines.push(...respond([info("No artifacts generated yet")]));
      } else {
        lines.push(...respond([
          title(`🎨 Artifacts (${artifacts.length})`),
          ...artifacts.map((a: any) => bullet(`${a.kind} — ${a.videoId ?? "course"} (${a.modelRole ?? "unknown"})`)),
        ]));
      }
      return { lines, state };
    }

    // Export
    if (cmd === "/export" || cmd === "export") {
      let courseId = state.currentCourse;
      let outputDir: string | undefined;

      for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (token === "--dir") {
          outputDir = rest[index + 1];
          index += 1;
          continue;
        }
        if (!courseId && !token.startsWith("/")) {
          courseId = token;
        }
      }

      if (!courseId) {
        lines.push(warn("Usage: /export [courseId] [--dir path]"));
        return { lines, state };
      }

      try {
        const exported = await ctx.exportFactory(courseId, outputDir);
        lines.push(...respond([
          ok(`📦 Exported ${exported.courseId}`),
          badge("JSON:", exported.jsonPath),
          badge("Markdown:", exported.markdownPath),
          ...(exported.htmlPath ? [badge("HTML:", exported.htmlPath)] : []),
        ]));
      } catch (e: any) {
        lines.push(fail(`Error: ${e.message}`));
      }
      return { lines, state };
    }

    // Visual artifact generation commands
    if (cmd === "/notes" || cmd === "/flashcards" || cmd === "/infographic") {
      if (!state.currentCourse) { lines.push(warn("No course loaded. Process a video first.")); return { lines, state }; }
      
      const s = ctx.loadSavedCourse(state.currentCourse);
      if (!s) { lines.push(fail(`Course "${state.currentCourse}" not found`)); return { lines, state }; }

      const artifactType = cmd.slice(1); // remove leading /
      const artifactData = s.artifacts?.find((a: any) => a.kind === artifactType);
      
      if (!artifactData) {
        lines.push(...respond([warn(`No ${artifactType} artifact found. Run process with --outputs ${artifactType}`)]));
        return { lines, state };
      }

      // Generate HTML artifact
      const COURSE_DIR = join(homedir(), ".learnframe", "courses");
      const exportDir = join(COURSE_DIR, "exports", state.currentCourse);
      mkdirSync(exportDir, { recursive: true });
      
      const htmlPath = join(exportDir, `${state.currentCourse}-${artifactType}.html`);
      const html = generateHtmlArtifact(artifactType, `${state.currentCourse} — ${artifactType}`, artifactData.data);
      writeFileSync(htmlPath, html);

      lines.push(...respond([
        ok(`✨ Generated ${artifactType} artifact`),
        badge("HTML:", htmlPath),
        info("Open in browser to view visual output"),
      ]));
      return { lines, state };
    }

    // List courses
    if (cmd === "courses") {
      const saved = ctx.listSavedCourses();
      if (saved.length === 0) {
        lines.push(info("No saved courses"));
      } else {
        lines.push(...respond(saved.map((c, i) => numbered(i + 1, c))));
      }
      return { lines, state };
    }

    // Show URL
    if (cmd === "url") {
      lines.push(state.currentUrl ? badge("URL:", state.currentUrl) : info("No course loaded"));
      return { lines, state };
    }

    // Load course
    if (cmd === "course") {
      const id = rest[0];
      if (!id) { lines.push(warn("Usage: course <id>")); return { lines, state }; }
      const s = ctx.loadSavedCourse(id);
      if (!s) { lines.push(fail(`Course "${id}" not found`)); return { lines, state }; }
      state.currentCourse = id;
      state.currentUrl = s.url;
      state.mode = "chat";
      lines.push(...respond([
        ok(`📚 Loaded "${id}"`),
        badge("Mode:", "CHAT — ask questions naturally"),
        badge("Chunks:", String(s.chunkCount || 0)),
        badge("Artifacts:", String((s.artifacts || []).length)),
        info("Type /help for available commands"),
      ]));
      return { lines, state };
    }

    // Resolve URL
    if (cmd === "resolve") {
      const url = rest.join(" ");
      if (!url) { lines.push(warn("Usage: resolve <url>")); return { lines, state }; }
      try {
        const result = await ctx.resolveUrl(url);
        state.currentCourse = result.courseId;
        state.currentUrl = url;
        lines.push(...respond([
          ok(`🔗 Resolved: ${result.videos.length} video(s)`),
          ...result.videos.map((v: any) => bullet(`${v.id} — ${v.title || "no title"}`)),
        ]));
      } catch (e: any) { lines.push(fail(`Error: ${e.message}`)); }
      return { lines, state };
    }

    // Transcript command
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

    // Process command
    if (cmd === "process") {
      const apiKey = ctx.getApiKey();
      if (!apiKey) { lines.push(fail("OPENAI_API_KEY not set")); return { lines, state }; }
      const useWhisper = rest.includes("--whisper");
      const otIdx = rest.findIndex((s) => s === "--outputs");
      const outputs = otIdx >= 0 ? rest[otIdx + 1] : "notes,summary";
      const urlParts = otIdx >= 0 ? rest.slice(0, otIdx) : rest.filter((s) => s !== "--whisper");
      const url = urlParts.join(" ");
      if (!url) { lines.push(warn("Usage: process <url> [--outputs notes,summary] [--whisper]")); return { lines, state }; }

      try {
        const result = await ctx.processFactory(url, apiKey, outputs, useWhisper);
        state.currentCourse = result.courseId;
        state.currentUrl = url;
        state.mode = "chat";
        lines.push(...respond([
          ok(`✨ Done! ${result.artifactCount} artifacts generated`),
          ...result.artifactKinds.map((k: string) => bullet(`${k} (${result.modelRole})`)),
          "",
          paint(C.brightGreen, "💡 Chat mode activated!"),
          info("Just type your questions naturally — no 'ask' needed"),
          info("Type /help for slash commands"),
        ]));
      } catch (e: any) { lines.push(fail(`Error: ${e.message}`)); }
      return { lines, state };
    }

    // Quit chat mode
    if (cmd === "/quit" || cmd === "!quit") {
      state.mode = "command";
      state.currentCourse = undefined;
      state.currentUrl = undefined;
      lines.push(info("Switched to command mode"));
      return { lines, state };
    }

    // CHAT MODE: plain text = ask question
    if (state.mode === "chat" && !cmd.startsWith("/") && !cmd.startsWith("!")) {
      const apiKey = ctx.getApiKey();
      if (!apiKey) { 
        lines.push(...respond([fail("OPENAI_API_KEY not set")]));
        return { lines, state }; 
      }
      if (!state.currentCourse) { 
        lines.push(...respond([warn("No course loaded")]));
        return { lines, state }; 
      }

      const question = trimmed;
      
      try {
        if (!llm.instance) llm.instance = await ctx.llmFactory(apiKey);
        const courseState = ctx.loadSavedCourse(state.currentCourse);
        if (!courseState) { 
          lines.push(...respond([fail(`Course "${state.currentCourse}" not found on disk.`)]));
          return { lines, state }; 
        }

        const { createRetrievalQaEngine } = await import("../qa/retrieval.js");
        const engine = createRetrievalQaEngine({ chunks: courseState.chunks, artifacts: courseState.artifacts, llm: llm.instance, maxContextChunks: 4 });
        const answer = await engine.ask({ courseId: state.currentCourse, question });

        state.chatHistory.push({ role: "user", text: question });

        if (answer.status === "insufficient_context") {
          state.chatHistory.push({ role: "assistant", text: answer.answer });
          lines.push(...respond([
            answer.answer,
            `  ${paint(C.dim, `(reason: ${answer.confidence.reason.slice(0, 200)})`)}`,
          ]));
          return { lines, state };
        }
        
        const ansLines: string[] = [paint(C.brightWhite, answer.answer)];
        if (answer.citations.length > 0) {
          ansLines.push("");
          ansLines.push(title(`📍 Citations (${answer.citations.length})`));
          answer.citations.forEach((c: any) => ansLines.push(bullet(`${c.videoId} [${fmt(c.startSeconds)}-${fmt(c.endSeconds)}]`)));
        }
        if (answer.replayRanges.length > 0) {
          ansLines.push("");
          ansLines.push(title("▶️ Replay"));
          answer.replayRanges.forEach((r: any) => ansLines.push(bullet(`${r.videoId} [${fmt(r.startSeconds)}-${fmt(r.endSeconds)}]`)));
        }
        if (answer.followUpQuestions.length > 0) {
          ansLines.push("");
          ansLines.push(title("💭 Follow-ups"));
          answer.followUpQuestions.forEach((q: string) => ansLines.push(bullet(q)));
        }
        
        state.chatHistory.push({ role: "assistant", text: answer.answer });
        lines.push(...respond(ansLines));
      } catch (e: any) { 
        lines.push(...respond([fail(`Error: ${e.message}`)]));
      }
      return { lines, state };
    }

    // Unknown command
    if (state.mode === "chat") {
      lines.push(...respond([warn(`Unknown command "${cmd}". Available: /notes, /flashcards, /infographic, /export, /status, /artifacts, /quit`)]));
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

      // Generate HTML artifacts if they exist
      const htmlPath = join(exportDir, `${courseId}.html`);
      if (savedCourse.artifacts?.length > 0) {
        const html = generateHtmlArtifact("infographic", courseId, {
          stats: {
            "Videos": Array.isArray(savedCourse.videos) ? savedCourse.videos.length : 1,
            "Artifacts": savedCourse.artifacts.length,
            "Chunks": savedCourse.chunkCount || 0,
          },
          items: savedCourse.artifacts.map((a: any) => ({
            title: a.kind,
            description: a.videoId ? `For video: ${a.videoId}` : "Course-level artifact",
            tags: [a.modelRole || "unknown"],
          })),
        });
        writeFileSync(htmlPath, html);
      }

      return { courseId, jsonPath, markdownPath, htmlPath: existsSync(htmlPath) ? htmlPath : undefined };
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
