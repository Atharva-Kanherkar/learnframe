import * as readline from "node:readline";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { parseYoutubeUrl, createInMemorySourceResolver, createInMemoryStorage, createLearnFrame } from "../index.js";
import { buildExportPackResult } from "../export/pack.js";
import type { CourseProcessingState, Transcript, StorageAdapter, ArtifactKind } from "../contracts.js";
import { createVideoPlayer, detectBackends, pickBackend, type VideoBackend, type VideoPlayer, type KittyFrameDisplay } from "./video-player.js";

const execAsync = promisify(exec);

export const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m",
  magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[37m",
  brightBlack: "\x1b[90m", brightRed: "\x1b[91m", brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m", brightBlue: "\x1b[94m", brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m", brightWhite: "\x1b[97m",
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function paint(c: string, text: string) { return `${c}${text}${C.reset}`; }
export function stripAnsi(str: string): string { return str.replace(ANSI_RE, ""); }

function maxWidth(lines: string[]): number {
  return Math.max(...lines.map((l) => stripAnsi(l).length), 40);
}

export function chatBubble(author: string, color: string, lines: string[]): string[] {
  const w = Math.min(78, maxWidth(lines) + 4);
  const top = `${color}╭─ ${C.bold}${author}${C.reset}${color}${"─".repeat(w - stripAnsi(author).length - 3)}╮${C.reset}`;
  const body = lines.map((line) => {
    const pad = " ".repeat(Math.max(0, w - stripAnsi(line).length));
    return `${color}│${C.reset} ${line}${pad} ${color}│${C.reset}`;
  });
  const bottom = `${color}╰${"─".repeat(w)}╯${C.reset}`;
  return [top, ...body, bottom];
}

export function userBubble(text: string): string[] {
  return chatBubble("You", C.green, [text]);
}

export function assistantBubble(lines: string[]): string[] {
  return chatBubble("LearnFrame", C.brightCyan, lines);
}

export function createSpinner(text: string) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let interval: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      let i = 0;
      interval = setInterval(() => {
        process.stderr.write(`\r  ${paint(C.brightCyan, frames[i])} ${text} `);
        i = (i + 1) % frames.length;
      }, 80);
    },
    stop(final = paint(C.green, "✓")) {
      if (interval) clearInterval(interval);
      process.stderr.write(`\r  ${final} ${text}        \n`);
    },
    fail() {
      if (interval) clearInterval(interval);
      process.stderr.write(`\r  ${paint(C.red, "✗")} ${text}        \n`);
    },
  };
}

// ---------------------------------------------------------------------------
// HTML Artifact Generator
// ---------------------------------------------------------------------------
export function generateHtmlArtifact(type: string, title: string, content: any): string {
  const styles = `
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; background: #0f172a; color: #e2e8f0; }
      h1 { color: #38bdf8; border-bottom: 2px solid #38bdf8; padding-bottom: 10px; }
      h2 { color: #818cf8; margin-top: 30px; }
      .card { background: #1e293b; border-radius: 12px; padding: 20px; margin: 15px 0; border-left: 4px solid #38bdf8; }
      .flashcard { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); border-radius: 16px; padding: 30px; margin: 20px 0; border: 2px solid #475569; }
      .flashcard-front { font-size: 1.3em; font-weight: 600; color: #fbbf24; margin-bottom: 15px; }
      .flashcard-back { color: #cbd5e1; line-height: 1.6; }
      .tag { display: inline-block; background: #38bdf8; color: #0f172a; padding: 4px 12px; border-radius: 20px; font-size: 0.85em; margin: 5px 5px 5px 0; font-weight: 600; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin: 20px 0; }
      .metric { text-align: center; padding: 20px; background: #1e293b; border-radius: 12px; }
      .metric-value { font-size: 2em; font-weight: 700; color: #38bdf8; }
      .metric-label { color: #94a3b8; margin-top: 5px; }
      .video-embed { position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 12px; margin: 20px 0; }
      .video-embed iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }
    </style>
  `;

  let bodyContent = "";
  switch (type) {
    case "flashcards": {
      const cards = content.cards || [];
      bodyContent = `<h1>${title}</h1>
        <div class="grid"><div class="metric"><div class="metric-value">${cards.length}</div><div class="metric-label">Cards</div></div></div>
        ${cards.map((card: any, i: number) => `
          <div class="flashcard">
            <div class="flashcard-front">Q${i + 1}: ${card.front || card.question || ""}</div>
            <div class="flashcard-back">${card.back || card.answer || ""}</div>
            ${card.tags ? `<div>${card.tags.map((t: string) => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
          </div>
        `).join("")}`;
      break;
    }
    case "notes": {
      const sections = content.sections || [];
      bodyContent = `<h1>${title}</h1>
        ${sections.map((section: any) => `
          <div class="card">
            <h2>${section.heading || ""}</h2>
            <p>${section.content || ""}</p>
            ${section.keyPoints ? `<ul>${section.keyPoints.map((p: string) => `<li>${p}</li>`).join("")}</ul>` : ""}
          </div>
        `).join("")}`;
      break;
    }
    case "infographic": {
      const stats = content.stats || {};
      const items = content.items || [];
      bodyContent = `<h1>${title}</h1>
        <div class="grid">${Object.entries(stats).map(([k, v]) => `<div class="metric"><div class="metric-value">${v}</div><div class="metric-label">${k}</div></div>`).join("")}</div>
        ${items.map((item: any) => `
          <div class="card">
            <h2>${item.title || ""}</h2>
            <p>${item.description || ""}</p>
            ${item.tags ? `<div>${item.tags.map((t: string) => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
          </div>
        `).join("")}`;
      break;
    }
    case "player": {
      const videoId = content.videoId || "";
      const start = content.startSeconds || 0;
      bodyContent = `<h1>${title}</h1>
        <div class="video-embed">
          <iframe src="https://www.youtube.com/embed/${videoId}?start=${start}&autoplay=1" allowfullscreen></iframe>
        </div>
        <div class="card">
          <p>Video: ${content.videoTitle || videoId}</p>
          <p>Timestamp: ${formatTimestamp(start)}</p>
        </div>`;
      break;
    }
    default:
      bodyContent = `<h1>${title}</h1><div class="card"><pre>${JSON.stringify(content, null, 2)}</pre></div>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>${styles}</head><body>${bodyContent}</body></html>`;
}

function formatTimestamp(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Video playback helper
// ---------------------------------------------------------------------------
async function openVideo(videoId: string, startSeconds = 0, title = ""): Promise<string> {
  const url = `https://youtube.com/watch?v=${videoId}&t=${startSeconds}s`;
  
  // Try mpv first (best terminal video player)
  try {
    await execAsync(`which mpv`);
    // mpv can play YouTube directly via yt-dlp/yt-dlp integration
    return `mpv "${url}"`;
  } catch {
    // Fall back to opening browser
    const platform = process.platform;
    if (platform === "darwin") {
      return `open "${url}"`;
    } else if (platform === "win32") {
      return `start "${url}"`;
    } else {
      return `xdg-open "${url}"`;
    }
  }
}

// ---------------------------------------------------------------------------
// TUI types
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
  openUrl?: (url: string) => Promise<void>;
  videoPlayer?: VideoPlayer;
};

export type TuiState = {
  currentCourse: string | undefined;
  currentUrl: string | undefined;
  mode: "command" | "chat";
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
    ...initial,
  };
  const llm: { instance: any | undefined } = { instance: undefined };
  const videoPlayer = ctx.videoPlayer ?? createVideoPlayer();

  async function handle(input: string): Promise<TuiOutput> {
    const lines: string[] = [];
    const trimmed = input.trim();
    if (!trimmed) return { lines: [], state };

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rest = parts.slice(1);

    // Always show user message as bubble in chat mode
    if (state.mode === "chat" && !cmd.startsWith("/") && !cmd.startsWith("!") && cmd !== "exit" && cmd !== "quit") {
      lines.push(...userBubble(trimmed));
    }

    if (cmd === "exit" || cmd === "quit") { lines.push("exit"); return { lines, state }; }

    // HELP
    if (cmd === "help" || cmd === "?") {
      if (state.mode === "chat") {
        lines.push(...assistantBubble([
          paint(C.bold, "Chat Commands:"),
          "  Just type — ask anything about the video",
          "  /notes, /flashcards, /infographic — generate artifacts",
          "  /play [timestamp] — open video in browser",
          "  /video [timestamp] [--backend=kitty|tct|browser] — play in terminal",
          "  /stop — stop terminal playback",
          "  /export — export course",
          "  /status — show course info",
          "  /quit — leave chat",
        ]));
      } else {
        lines.push(...assistantBubble([
          paint(C.bold, "Commands:"),
          "  process <url> [--whisper] — process video",
          "  course <id> — load saved course",
          "  courses — list courses",
          "  resolve <url> — preview metadata",
          "  delete <id> — remove course",
          "  config — check API key",
        ]));
      }
      return { lines, state };
    }

    // CONFIG
    if (cmd === "config") {
      lines.push(...assistantBubble([`OPENAI_API_KEY: ${ctx.getApiKey() ? paint(C.green, "set") : paint(C.red, "not set")}`]));
      return { lines, state };
    }

    // DELETE
    if (cmd === "delete") {
      const id = rest[0];
      if (!id) { lines.push(...assistantBubble([paint(C.yellow, "Usage: delete <id>")])); return { lines, state }; }
      ctx.deleteCourse(id);
      if (state.currentCourse === id) {
        state.currentCourse = undefined; state.currentUrl = undefined; state.mode = "command";
      }
      lines.push(...assistantBubble([paint(C.green, `Deleted "${id}"`)]));
      return { lines, state };
    }

    // COURSES
    if (cmd === "courses") {
      const saved = ctx.listSavedCourses();
      if (saved.length === 0) {
        lines.push(...assistantBubble(["No saved courses"]));
      } else {
        lines.push(...assistantBubble(saved.map((c, i) => `${i + 1}. ${c}`)));
      }
      return { lines, state };
    }

    // URL
    if (cmd === "url") {
      lines.push(...assistantBubble([state.currentUrl || "No course loaded"]));
      return { lines, state };
    }

    // COURSE
    if (cmd === "course") {
      const id = rest[0];
      if (!id) { lines.push(...assistantBubble([paint(C.yellow, "Usage: course <id>")])); return { lines, state }; }
      const s = ctx.loadSavedCourse(id);
      if (!s) { lines.push(...assistantBubble([paint(C.red, `Course "${id}" not found`)])); return { lines, state }; }
      state.currentCourse = id; state.currentUrl = s.url; state.mode = "chat";
      lines.push(...assistantBubble([
        paint(C.green, `Loaded "${id}"`),
        `${s.chunkCount || 0} chunks, ${(s.artifacts || []).length} artifacts`,
        "Type your questions naturally.",
      ]));
      return { lines, state };
    }

    // RESOLVE
    if (cmd === "resolve") {
      const url = rest.join(" ");
      if (!url) { lines.push(...assistantBubble([paint(C.yellow, "Usage: resolve <url>")])); return { lines, state }; }
      try {
        const r = await ctx.resolveUrl(url);
        state.currentCourse = r.courseId; state.currentUrl = url;
        lines.push(...assistantBubble([
          paint(C.green, `Resolved: ${r.videos.length} video(s)`),
          ...r.videos.map((v: any) => `• ${v.id} — ${v.title || "no title"}`),
        ]));
      } catch (e: any) { lines.push(...assistantBubble([paint(C.red, e.message)])); }
      return { lines, state };
    }

    // TRANSCRIPT
    if (cmd === "transcript") {
      const raw = rest.join(" ");
      const useWhisper = raw.includes("--whisper");
      const url = raw.replace(/--whisper/g, "").trim().split(/\s+/)[0];

      if (!url && state.currentCourse) {
        const s = ctx.loadSavedCourse(state.currentCourse);
        if (s?.transcripts?.[0]) {
          const t = s.transcripts[0];
          lines.push(...assistantBubble([
            `${t.status} — ${t.segments.length} segments`,
            t.provenance ? `${t.provenance.provider} / ${t.provenance.language}` : "",
            `"${t.segments.slice(0, 3).map((s: any) => s.text).join(" ")}..."`,
          ].filter(Boolean)));
        } else {
          lines.push(...assistantBubble(["No transcript"]));
        }
        return { lines, state };
      }

      if (!url) { lines.push(...assistantBubble([paint(C.yellow, "Usage: transcript <url> [--whisper]")])); return { lines, state }; }
      const spinner = createSpinner("Extracting transcript"); spinner.start();
      try {
        const t = await ctx.transcriptFactory(url, ctx.getApiKey(), useWhisper);
        spinner.stop();
        lines.push(...assistantBubble([
          `${t.status} — ${t.segments.length} segments`,
          `"${t.segments.slice(0, 3).map((s: any) => s.text).join(" ")}..."`,
        ]));
      } catch (e: any) { spinner.fail(); lines.push(...assistantBubble([paint(C.red, e.message)])); }
      return { lines, state };
    }

    // PROCESS
    if (cmd === "process") {
      const apiKey = ctx.getApiKey();
      if (!apiKey) { lines.push(...assistantBubble([paint(C.red, "Set OPENAI_API_KEY")])); return { lines, state }; }
      const useWhisper = rest.includes("--whisper");
      const otIdx = rest.findIndex((s) => s === "--outputs");
      const outputs = otIdx >= 0 ? rest[otIdx + 1] : "notes,summary";
      const urlParts = otIdx >= 0 ? rest.slice(0, otIdx) : rest.filter((s) => s !== "--whisper");
      const url = urlParts.join(" ");
      if (!url) { lines.push(...assistantBubble([paint(C.yellow, "Usage: process <url>")])); return { lines, state }; }

      const spinner = createSpinner("Processing"); spinner.start();
      try {
        const r = await ctx.processFactory(url, apiKey, outputs, useWhisper);
        state.currentCourse = r.courseId; state.currentUrl = url; state.mode = "chat";
        spinner.stop();
        lines.push(...assistantBubble([
          paint(C.green, `${r.artifactCount} artifacts`),
          ...r.artifactKinds.map((k: string) => `• ${k}`),
          "",
          paint(C.brightCyan, "Chat mode active. Ask questions naturally."),
        ]));
      } catch (e: any) { spinner.fail(); lines.push(...assistantBubble([paint(C.red, e.message)])); }
      return { lines, state };
    }

    // QUIT CHAT
    if (cmd === "/quit" || cmd === "!quit") {
      state.mode = "command"; state.currentCourse = undefined; state.currentUrl = undefined;
      lines.push(...assistantBubble(["Left chat. Type 'process <url>' to start again."]));
      return { lines, state };
    }

    // STATUS
    if (cmd === "/status" || cmd === "status") {
      if (!state.currentCourse) { lines.push(...assistantBubble(["No course"]));
        return { lines, state }; }
      const s = ctx.loadSavedCourse(state.currentCourse);
      if (!s) { lines.push(...assistantBubble(["Course not found"])); return { lines, state }; }
      lines.push(...assistantBubble([
        paint(C.bold, state.currentCourse),
        `${s.videos?.length || 0} videos, ${s.chunkCount || 0} chunks, ${s.artifacts?.length || 0} artifacts`,
      ]));
      return { lines, state };
    }

    // ARTIFACTS
    if (cmd === "/artifacts") {
      if (!state.currentCourse) { lines.push(...assistantBubble(["No course"])); return { lines, state }; }
      const s = ctx.loadSavedCourse(state.currentCourse);
      const artifacts: any[] = s?.artifacts ?? [];
      if (artifacts.length === 0) { lines.push(...assistantBubble(["No artifacts"])); }
      else { lines.push(...assistantBubble(artifacts.map((a: any) => `• ${a.kind}`))); }
      return { lines, state };
    }

    // EXPORT
    if (cmd === "/export" || cmd === "export") {
      const courseId = state.currentCourse || rest[0];
      if (!courseId) { lines.push(...assistantBubble([paint(C.yellow, "Usage: /export [courseId]")])); return { lines, state }; }
      try {
        const e = await ctx.exportFactory(courseId, rest.includes("--dir") ? rest[rest.indexOf("--dir") + 1] : undefined);
        lines.push(...assistantBubble([paint(C.green, "Exported"), e.jsonPath, e.markdownPath, ...(e.htmlPath ? [e.htmlPath] : [])]));
      } catch (e: any) { lines.push(...assistantBubble([paint(C.red, e.message)])); }
      return { lines, state };
    }

    // PLAY VIDEO
    if (cmd === "/play") {
      if (!state.currentCourse) { lines.push(...assistantBubble(["No course"])); return { lines, state }; }
      const s = ctx.loadSavedCourse(state.currentCourse);
      const videoId = s?.videos?.[0]?.id || parseYoutubeUrl(state.currentUrl || "").videoId;
      const start = rest[0] ? parseTimestamp(rest[0]) : 0;
      if (!videoId) { lines.push(...assistantBubble(["No video"]));
        return { lines, state }; }

      const url = `https://youtube.com/watch?v=${videoId}&t=${start}s`;
      if (ctx.openUrl) {
        await ctx.openUrl(url);
      } else {
        try {
          const { exec } = await import("node:child_process");
          const cmd = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "${url}"` : `xdg-open "${url}"`;
          exec(cmd);
        } catch { /* noop */ }
      }
      lines.push(...assistantBubble([paint(C.green, "▶️  Opened video"), `${url}`]));
      return { lines, state };
    }

    // VIDEO (terminal playback)
    if (cmd === "/video") {
      if (!state.currentCourse) { lines.push(...assistantBubble(["No course"])); return { lines, state }; }
      const s = ctx.loadSavedCourse(state.currentCourse);
      const videoId = s?.videos?.[0]?.id || (state.currentUrl ? parseYoutubeUrl(state.currentUrl).videoId : undefined);
      const backendFlag = rest.find((r) => r.startsWith("--backend="));
      const preferredBackend = backendFlag ? (backendFlag.split("=")[1] as VideoBackend) : undefined;
      const tsArg = rest.find((r) => !r.startsWith("--"));
      const start = tsArg ? parseTimestamp(tsArg) : 0;
      if (!videoId) { lines.push(...assistantBubble(["No video"])); return { lines, state }; }

      try {
        const result = await videoPlayer.play(videoId, start, preferredBackend);
        lines.push(...assistantBubble([paint(C.green, `▶️  ${result.message}`), `Backend: ${result.backend}`]));
      } catch (e: any) {
        lines.push(...assistantBubble([paint(C.red, `Playback failed: ${e.message}`)]));
      }
      return { lines, state };
    }

    // STOP
    if (cmd === "/stop") {
      if (!videoPlayer.isPlaying()) {
        lines.push(...assistantBubble(["Nothing playing"]));
        return { lines, state };
      }
      await videoPlayer.stop();
      lines.push(...assistantBubble([paint(C.green, "⏹  Stopped")]));
      return { lines, state };
    }

    // VISUAL ARTIFACTS
    if (cmd === "/notes" || cmd === "/flashcards" || cmd === "/infographic") {
      if (!state.currentCourse) { lines.push(...assistantBubble(["No course"])); return { lines, state }; }
      const s = ctx.loadSavedCourse(state.currentCourse);
      const type = cmd.slice(1);
      const artifact = s?.artifacts?.find((a: any) => a.kind === type);
      if (!artifact) { lines.push(...assistantBubble([`No ${type} artifact. Process with --outputs ${type}`])); return { lines, state }; }

      const COURSE_DIR = join(homedir(), ".learnframe", "courses");
      const exportDir = join(COURSE_DIR, "exports", state.currentCourse);
      mkdirSync(exportDir, { recursive: true });
      const htmlPath = join(exportDir, `${state.currentCourse}-${type}.html`);
      writeFileSync(htmlPath, generateHtmlArtifact(type, `${state.currentCourse} — ${type}`, artifact.data));

      // Open the HTML file
      try {
        const { exec } = await import("node:child_process");
        const openCmd = process.platform === "darwin" ? `open "${htmlPath}"` : process.platform === "win32" ? `start "${htmlPath}"` : `xdg-open "${htmlPath}"`;
        exec(openCmd);
      } catch { /* noop */ }

      lines.push(...assistantBubble([paint(C.green, `✨ ${type} ready`), htmlPath]));
      return { lines, state };
    }

    // CHAT: plain text = ask
    if (state.mode === "chat" && !cmd.startsWith("/") && !cmd.startsWith("!")) {
      const apiKey = ctx.getApiKey();
      if (!apiKey) { lines.push(...assistantBubble([paint(C.red, "Set OPENAI_API_KEY")])); return { lines, state }; }
      if (!state.currentCourse) { lines.push(...assistantBubble(["No course"])); return { lines, state }; }

      const question = trimmed;
      const spinner = createSpinner("Thinking"); spinner.start();

      try {
        if (!llm.instance) llm.instance = await ctx.llmFactory(apiKey);
        const courseState = ctx.loadSavedCourse(state.currentCourse);
        if (!courseState) { spinner.fail(); lines.push(...assistantBubble(["Course not found"])); return { lines, state }; }

        const { createRetrievalQaEngine } = await import("../qa/retrieval.js");
        const engine = createRetrievalQaEngine({ chunks: courseState.chunks, artifacts: courseState.artifacts, llm: llm.instance, maxContextChunks: 4 });
        const answer = await engine.ask({ courseId: state.currentCourse, question });
        spinner.stop();

        if (answer.status === "insufficient_context") {
          lines.push(...assistantBubble([answer.answer, paint(C.dim, `(${answer.confidence.reason})`)]));
          return { lines, state };
        }

        const ansLines: string[] = [answer.answer];
        if (answer.citations.length > 0) {
          ansLines.push("");
          ansLines.push(paint(C.brightCyan, `📍 ${answer.citations.length} citation${answer.citations.length > 1 ? "s" : ""}`));
          answer.citations.forEach((c: any) => {
            ansLines.push(`  ${c.videoId} [${formatTimestamp(c.startSeconds)}]`);
          });
          // Add play hint
          if (answer.citations[0]) {
            const c = answer.citations[0];
            ansLines.push("");
            ansLines.push(paint(C.dim, `Type /play ${formatTimestamp(c.startSeconds)} to watch`));
          }
        }
        if (answer.followUpQuestions.length > 0) {
          ansLines.push("");
          ansLines.push(paint(C.dim, "Follow-up:"));
          answer.followUpQuestions.forEach((q: string) => ansLines.push(`  • ${q}`));
        }
        lines.push(...assistantBubble(ansLines));
      } catch (e: any) { spinner.fail(); lines.push(...assistantBubble([paint(C.red, e.message)])); }
      return { lines, state };
    }

    // Unknown
    if (state.mode === "chat") {
      lines.push(...assistantBubble([paint(C.yellow, `Unknown: ${cmd}`), "Available: /notes /flashcards /infographic /play /video /stop /export /status /quit"]));
    } else {
      lines.push(...assistantBubble([paint(C.yellow, `Unknown: ${cmd}`), "Type 'help' for commands."]));
    }
    return { lines, state };
  }

  return { handle, getState: () => state };
}

function parseTimestamp(ts: string): number {
  // Accepts "123" (seconds), "2:03", "1:02:30"
  const parts = ts.split(":").map(Number);
  if (parts.length === 1) return parts[0] || 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

const COURSE_STATE_KEY_PREFIX = "course-state:v1:";

export function courseIdFromStorageKey(key: string): string {
  return key.startsWith(COURSE_STATE_KEY_PREFIX) ? key.slice(COURSE_STATE_KEY_PREFIX.length) : key;
}

function courseFileName(courseId: string): string {
  return `${encodeURIComponent(courseId)}.json`;
}

function decodeCourseFileName(fileName: string): string {
  const stem = fileName.replace(/\.json$/, "");
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

function courseFileCandidates(courseDir: string, courseId: string): string[] {
  const legacyLastSegment = courseId.includes(":") ? courseId.split(":").pop() : undefined;
  const candidates = [
    join(courseDir, courseFileName(courseId)),
    join(courseDir, `${courseId}.json`),
    ...(legacyLastSegment ? [join(courseDir, `${legacyLastSegment}.json`), join(courseDir, courseFileName(legacyLastSegment))] : []),
  ];
  return [...new Set(candidates)];
}

export function createFileSystemCourseStore(courseDir: string) {
  mkdirSync(courseDir, { recursive: true });

  const canonicalPath = (courseId: string) => join(courseDir, courseFileName(courseId));
  const existingPath = (courseId: string) => courseFileCandidates(courseDir, courseId).find((p) => existsSync(p));

  function loadSavedCourse(id: string): any | undefined {
    const p = existingPath(id);
    return p ? JSON.parse(readFileSync(p, "utf8")) : undefined;
  }

  function saveCourse(id: string, state: any): void {
    writeFileSync(canonicalPath(id), JSON.stringify(state, null, 2));
  }

  function deleteCourse(id: string): void {
    for (const p of courseFileCandidates(courseDir, id)) {
      if (existsSync(p)) unlinkSync(p);
    }
  }

  const storage: StorageAdapter = {
    async get<T>(key: string): Promise<T | undefined> {
      return loadSavedCourse(courseIdFromStorageKey(key)) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      saveCourse(courseIdFromStorageKey(key), value);
    },
    async delete(key: string): Promise<void> {
      deleteCourse(courseIdFromStorageKey(key));
    },
    async has(key: string): Promise<boolean> {
      return Boolean(existingPath(courseIdFromStorageKey(key)));
    },
  };

  return {
    storage,
    listSavedCourses: () => {
      try {
        const ids = readdirSync(courseDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => {
            try {
              const parsed = JSON.parse(readFileSync(join(courseDir, f), "utf8"));
              return typeof parsed.courseId === "string" ? parsed.courseId : decodeCourseFileName(f);
            } catch {
              return decodeCourseFileName(f);
            }
          });
        return [...new Set(ids)];
      } catch {
        return [];
      }
    },
    loadSavedCourse,
    saveCourse,
    deleteCourse,
  };
}

// ---------------------------------------------------------------------------
// Default context
// ---------------------------------------------------------------------------
export function defaultTuiContext(): TuiContext {
  const COURSE_DIR = join(homedir(), ".learnframe", "courses");
  const courseStore = createFileSystemCourseStore(COURSE_DIR);

  return {
    courseDir: COURSE_DIR,
    getApiKey: () => process.env.OPENAI_API_KEY,
    now: () => new Date(),

    listSavedCourses: courseStore.listSavedCourses,
    loadSavedCourse: courseStore.loadSavedCourse,
    saveCourse: courseStore.saveCourse,
    deleteCourse: courseStore.deleteCourse,

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
      const r = await t.getTranscript({ id: vid, url, availability: "available" as any }, { language: "en" });
      if (r.status === "missing" && useWhisper && apiKey) {
        const w = new WhisperTranscriptProvider({ apiKey, storage, timeoutMs: 300_000 });
        return w.getTranscript({ id: vid, url, availability: "available" as any }, { allowPaidTranscription: true });
      }
      return r;
    },

    async processFactory(url: string, apiKey: string, outputs: string, useWhisper?: boolean) {
      const [{ YtDlpTranscriptProvider }, { createOpenAiLlmAdapter }] = await Promise.all([
        import("../adapters/yt-dlp-transcript.js"),
        import("./llm.js"),
      ]);
      const storage = courseStore.storage;
      const llm = await createOpenAiLlmAdapter(apiKey);
      const transcriptProvider = new YtDlpTranscriptProvider({ storage: createInMemoryStorage(), timeoutMs: 120_000 });
      const sdk = createLearnFrame({
        sourceResolver: createInMemorySourceResolver({}),
        storage,
        transcriptProvider,
        llm,
        onProgress: (event) => {
          const icon = event.status === "completed" ? paint(C.green, "✓") : event.status === "failed" ? paint(C.red, "✗") : paint(C.brightCyan, "⏳");
          console.error(`  ${icon} ${event.stage}`);
        },
      });
      const result = await sdk.process({
        source: { type: "video", url },
        outputs: outputs.split(",").map((s) => s.trim()) as ArtifactKind[],
        transcript: useWhisper ? { allowPaidTranscription: true } : undefined,
      });
      return {
        courseId: result.courseId,
        url,
        artifactCount: result.artifacts.length,
        artifactKinds: result.artifacts.map((a: any) => a.kind),
        modelRole: "cheap",
      };
    },

    async exportFactory(courseId: string, outputDir?: string) {
      const savedCourse = this.loadSavedCourse(courseId);
      if (!savedCourse) throw new Error(`Course "${courseId}" not found`);
      const state = coerceSavedCourseToProcessingState(savedCourse);
      const exportPack = buildExportPackResult(state, this.now().toISOString());
      const exportDir = outputDir ?? join(COURSE_DIR, "exports", courseId);
      mkdirSync(exportDir, { recursive: true });
      const jsonPath = join(exportDir, `${courseId}.json`);
      const markdownPath = join(exportDir, `${courseId}.md`);
      writeFileSync(jsonPath, exportPack.json);
      writeFileSync(markdownPath, exportPack.markdown);

      const htmlPath = join(exportDir, `${courseId}.html`);
      if (savedCourse.artifacts?.length > 0) {
        const html = generateHtmlArtifact("infographic", courseId, {
          stats: { "Videos": savedCourse.videos?.length || 1, "Artifacts": savedCourse.artifacts.length, "Chunks": savedCourse.chunkCount || 0 },
          items: savedCourse.artifacts.map((a: any) => ({ title: a.kind, description: a.videoId || "course", tags: [a.modelRole || "unknown"] })),
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
  const videos = Array.isArray(savedCourse.videos) && savedCourse.videos.length > 0 ? savedCourse.videos : [{ id: courseId, url: savedCourse.url ?? "", availability: "available", position: 0 }];
  const transcripts: Transcript[] = Array.isArray(savedCourse.transcripts) ? savedCourse.transcripts : videos.map((v: any) => ({ videoId: v.id, status: "missing", segments: [] }));
  const chunks = Array.isArray(savedCourse.chunks) ? savedCourse.chunks : [];
  const artifacts = Array.isArray(savedCourse.artifacts) ? savedCourse.artifacts : [];
  const processedVideos = Object.fromEntries(videos.map((video: any) => {
    const transcript = transcripts.find((t) => t.videoId === video.id) ?? { videoId: video.id, status: "missing", segments: [] };
    const videoChunks = chunks.filter((c: any) => c.videoId === video.id);
    const videoArtifacts = artifacts.filter((a: any) => a.videoId === video.id);
    const fingerprint = createHash("sha256").update(`${video.id}:${video.url ?? ""}:${video.etag ?? ""}`).digest("hex");
    return [video.id, { video, fingerprint, transcript, chunks: videoChunks, artifacts: videoArtifacts }];
  }));

  return {
    courseId,
    source: savedCourse.source ?? { type: "video", url: savedCourse.url ?? "" },
    playlist: savedCourse.playlist ?? { id: courseId, url: savedCourse.url ?? "", videos },
    videos, transcripts, chunks, artifacts, processedVideos,
    sourceResolution: savedCourse.sourceResolution,
    sync: savedCourse.sync ?? { added: [], updated: [], skipped: videos.map((v: any) => v.id) },
    createdAt: savedCourse.createdAt ?? now,
    updatedAt: savedCourse.updatedAt ?? now,
  };
}

function hashCourseUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}
