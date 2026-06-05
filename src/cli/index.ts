#!/usr/bin/env node
import * as readline from "node:readline";
import {
  createInMemoryStorage,
  createInMemorySourceResolver,
  YtDlpTranscriptProvider,
  WhisperTranscriptProvider,
  chunkTranscript,
  createLowCostArtifactEngine,
  createRetrievalQaEngine,
  parseYoutubeUrl,
  type ArtifactKind,
  type LlmAdapter,
  type LlmRequest,
  type Transcript,
} from "../index.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------
const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", magenta: "\x1b[35m" };

function color(c: string, text: string) { return `${c}${text}${C.reset}`; }

// ---------------------------------------------------------------------------
// OpenAI adapter
// ---------------------------------------------------------------------------
function createOpenAiLlmAdapter(apiKey: string, model = "gpt-4o-mini"): LlmAdapter {
  return {
    async generateStructured<T>(request: LlmRequest): Promise<T> {
      const schema = SCHEMAS[request.task];
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "Return only valid JSON matching the schema. Preserve citation and chunk IDs exactly." },
            { role: "user", content: JSON.stringify(request.input) },
          ],
          response_format: schema
            ? { type: "json_schema", json_schema: { name: request.task.replace(/-/g, "_"), strict: true, schema } }
            : { type: "json_object" },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => "")}`);
      return JSON.parse((await res.json() as any).choices[0].message.content) as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const COURSE_DIR = join(homedir(), ".learnframe", "courses");
mkdirSync(COURSE_DIR, { recursive: true });

function save(name: string, data: any) { writeFileSync(join(COURSE_DIR, `${name}.json`), JSON.stringify(data, null, 2)); }
function load(name: string): any | undefined {
  const p = join(COURSE_DIR, `${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}
function listCourses(): string[] {
  try { return readdirSync(COURSE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const CIT = { type: "object", additionalProperties: false, required: ["videoId","startSeconds","endSeconds","chunkId"], properties: { videoId:{type:"string"}, startSeconds:{type:"number"}, endSeconds:{type:"number"}, chunkId:{type:"string"} } };
const QA_CIT = { type: "object", additionalProperties: false, required: ["videoId","startSeconds","endSeconds","chunkId","text"], properties: { videoId:{type:"string"}, startSeconds:{type:"number"}, endSeconds:{type:"number"}, chunkId:{type:"string"}, text:{type:"string"} } };
const RNG = { type: "object", additionalProperties: false, required: ["videoId","startSeconds","endSeconds"], properties: { videoId:{type:"string"}, startSeconds:{type:"number"}, endSeconds:{type:"number"} } };
const SCHEMAS: Record<string, any> = {
  "chunk-notes": { type:"object", additionalProperties:false, required:["chunkId","videoId","summary","keyPoints","concepts","citations"], properties:{ chunkId:{type:"string"}, videoId:{type:"string"}, summary:{type:"string"}, keyPoints:{type:"array",items:{type:"string"}}, concepts:{type:"array",items:{type:"string"}}, citations:{type:"array",items:CIT} } },
  "video-summary": { type:"object", additionalProperties:false, required:["videoId","summary","keyPoints","citations"], properties:{ videoId:{type:"string"}, summary:{type:"string"}, keyPoints:{type:"array",items:{type:"string"}}, citations:{type:"array",items:CIT} } },
  "playlist-syllabus": { type:"object", additionalProperties:false, required:["courseId","title","modules"], properties:{ courseId:{type:"string"}, title:{type:"string"}, modules:{type:"array",items:{ type:"object",additionalProperties:false,required:["title","summary","videoIds","outcomes"], properties:{ title:{type:"string"}, summary:{type:"string"}, videoIds:{type:"array",items:{type:"string"}}, outcomes:{type:"array",items:{type:"string"}} } }} } },
  "glossary": { type:"object", additionalProperties:false, required:["terms"], properties:{ terms:{type:"array",items:{ type:"object",additionalProperties:false,required:["term","definition","citations"], properties:{ term:{type:"string"}, definition:{type:"string"}, citations:{type:"array",items:CIT} } }} } },
  "quiz": { type:"object", additionalProperties:false, required:["questions"], properties:{ questions:{type:"array",items:{ type:"object",additionalProperties:false,required:["question","choices","answer","explanation","citations"], properties:{ question:{type:"string"}, choices:{type:"array",items:{type:"string"},minItems:2}, answer:{type:"string"}, explanation:{type:"string"}, citations:{type:"array",items:CIT} } }} } },
  "flashcards": { type:"object", additionalProperties:false, required:["cards"], properties:{ cards:{type:"array",items:{ type:"object",additionalProperties:false,required:["front","back","citations"], properties:{ front:{type:"string"}, back:{type:"string"}, citations:{type:"array",items:CIT} } }} } },
  "study-plan": { type:"object", additionalProperties:false, required:["courseId","steps"], properties:{ courseId:{type:"string"}, steps:{type:"array",items:{ type:"object",additionalProperties:false,required:["title","objective","videoIds"], properties:{ title:{type:"string"}, objective:{type:"string"}, videoIds:{type:"array",items:{type:"string"}} } }} } },
  "prerequisite-map": { type:"object", additionalProperties:false, required:["prerequisites"], properties:{ prerequisites:{type:"array",items:{ type:"object",additionalProperties:false,required:["concept","requiredBefore","reason","citations"], properties:{ concept:{type:"string"}, requiredBefore:{type:"array",items:{type:"string"}}, reason:{type:"string"}, citations:{type:"array",items:CIT} } }} } },
  "retrieval-qa-answer": { type:"object", additionalProperties:false, required:["answer","status","citations","replayRanges","followUpQuestions","confidence"], properties:{ answer:{type:"string"}, status:{type:"string",enum:["answered","insufficient_context"]}, citations:{type:"array",items:QA_CIT}, replayRanges:{type:"array",items:RNG}, followUpQuestions:{type:"array",items:{type:"string"}}, confidence:{ type:"object",additionalProperties:false,required:["score","reason"], properties:{ score:{type:"number"}, reason:{type:"string"} } } } },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getTranscript(url: string, apiKey: string | undefined, storage: any): Promise<Transcript> {
  const vid = parseYoutubeUrl(url).videoId ?? url;
  const t = new YtDlpTranscriptProvider({ storage, timeoutMs: 120_000 });
  const r = await t.getTranscript({ id: vid, url, availability: "available" }, { language: "en" });
  if (r.status === "missing" && apiKey) {
    const w = new WhisperTranscriptProvider({ apiKey, storage, timeoutMs: 300_000 });
    return w.getTranscript({ id: vid, url, availability: "available" }, { allowPaidTranscription: true });
  }
  return r;
}

function parseOutputs(flags: string): ArtifactKind[] {
  return flags.split(",").map((s) => s.trim()) as ArtifactKind[];
}

// ---------------------------------------------------------------------------
// TUI state
// ---------------------------------------------------------------------------
let llm: LlmAdapter | undefined;
let currentCourse: string | undefined;
let currentUrl: string | undefined;
let rl: readline.Interface | undefined;

// ---------------------------------------------------------------------------
// TUI commands
// ---------------------------------------------------------------------------
const HELP = [
  "",
  color(C.bold, "LearnFrame TUI Commands"),
  "",
  `  ${color(C.cyan, "process <url> [--outputs kind,...]")}   Full pipeline: captions → chunks → artifacts → save`,
  `  ${color(C.cyan, "ask <question>")}                     Ask about the loaded course (cites timestamps)`,
  `  ${color(C.cyan, "resolve <url>")}                      Resolve YouTube URL to metadata`,
  `  ${color(C.cyan, "course <id>")}                       Load a previously saved course`,
  `  ${color(C.cyan, "courses")}                            List saved courses`,
  `  ${color(C.cyan, "transcript <url> [--whisper]")}       Extract captions (free) or transcribe`,
  `  ${color(C.cyan, "url")}                                Show current course URL`,
  `  ${color(C.cyan, "help")}                               Show this help`,
  `  ${color(C.cyan, "exit")}                               Quit`,
  "",
];

function printHelp() { HELP.forEach((l) => console.log(l)); }

async function handle(input: string): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = parts.slice(1);

  if (cmd === "exit" || cmd === "quit") { rl?.close(); return; }
  if (cmd === "help") { printHelp(); return; }
  if (cmd === "courses") { listCourses().forEach((c) => console.log(`  ${color(C.green, c)}`)); if (!listCourses().length) console.log(color(C.dim, "  No saved courses")); return; }
  if (cmd === "url") { console.log(currentUrl ? `  ${currentUrl}` : color(C.dim, "  No course loaded")); return; }

  if (cmd === "course") {
    const id = rest[0];
    if (!id) { console.log(color(C.red, "  Usage: course <id>")); return; }
    const s = load(id);
    if (!s) { console.log(color(C.red, `  Course "${id}" not found`)); return; }
    currentCourse = id;
    currentUrl = s.url;
    console.log(color(C.green, `  Loaded ${id} — ${s.chunkCount || 0} chunks, ${(s.artifacts || []).length} artifacts`));
    return;
  }

  if (cmd === "resolve") {
    const url = rest.join(" ");
    if (!url) { console.log(color(C.red, "  Usage: resolve <url>")); return; }
    const p = parseYoutubeUrl(url);
    const r = createInMemorySourceResolver({ videos: { [p.videoId ?? url]: { id: p.videoId ?? url, url, title: "YouTube video" } } });
    const result = await r.resolve({ type: "video", url: p.canonicalUrl, videoId: p.videoId }, { storage: createInMemoryStorage(), reportProgress: async () => {} });
    currentCourse = result.courseId;
    currentUrl = url;
    console.log(color(C.green, `  Resolved: ${result.videos.length} video(s)`));
    result.videos.forEach((v: any) => console.log(`    ${color(C.cyan, v.id)} — ${v.title || "no title"}`));
    return;
  }

  if (cmd === "transcript") {
    const args = rest.join(" ").replace(/--whisper/g, "");
    const url = args.trim().split(/\s+/)[0];
    if (!url) { console.log(color(C.red, "  Usage: transcript <url> [--whisper]")); return; }
    const useWhisper = rest.join(" ").includes("--whisper");
    console.log(color(C.dim, "  Extracting transcript..."));
    const t = await getTranscript(url, useWhisper ? process.env.OPENAI_API_KEY : undefined, createInMemoryStorage());
    console.log(color(C.green, `  Status: ${t.status} — ${t.segments.length} segments`));
    if (t.provenance) console.log(color(C.dim, `  ${t.provenance.provider} / ${t.provenance.language} / ${t.provenance.captionKind}`));
    console.log(color(C.dim, `  \"${t.segments.slice(0, 3).map((s) => s.text).join(" ")}...\"`));
    return;
  }

  if (cmd === "process") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) { console.log(color(C.red, "  OPENAI_API_KEY not set")); return; }
    const outputsIdx = rest.findIndex((s) => s === "--outputs");
    const outputs = outputsIdx >= 0 ? rest[outputsIdx + 1] : "notes,summary";
    const url = rest.slice(0, outputsIdx >= 0 ? outputsIdx : rest.length).join(" ");
    if (!url) { console.log(color(C.red, "  Usage: process <url> [--outputs notes,summary]") ); return; }

    llm = createOpenAiLlmAdapter(apiKey);
    const storage = createInMemoryStorage();
    console.log(color(C.dim, "  Extracting transcript..."));
    const transcript = await getTranscript(url, apiKey, storage);
    if (transcript.status !== "available" || transcript.segments.length === 0) {
      console.log(color(C.red, `  Transcript unavailable (${transcript.status})`));
      return;
    }
    const chunks = chunkTranscript(transcript);
    const kinds = parseOutputs(outputs);
    console.log(color(C.dim, `  ${transcript.segments.length} segments → ${chunks.length} chunks. Generating ${kinds.join(", ")}...`));

    const courseId = parseYoutubeUrl(url).videoId ?? url;
    const engine = createLowCostArtifactEngine({ llm, storage, maxConcurrentChunkNotes: 3 });
    const artifacts = await engine.generate({ courseId, chunks, outputs: kinds });

    currentCourse = courseId;
    currentUrl = url;
    save(courseId, { courseId, url, createdAt: new Date().toISOString(), chunkCount: chunks.length, chunks, artifacts });
    console.log(color(C.green, `  Done! ${artifacts.length} artifacts generated.`));
    artifacts.forEach((a: any) => console.log(`    ${color(C.cyan, a.kind)} (${a.modelRole})`));
    console.log(color(C.dim, `  Saved. Try: ask "what is this course about?"`));
    return;
  }

  if (cmd === "ask") {
    if (!llm) llm = createOpenAiLlmAdapter(process.env.OPENAI_API_KEY || "");
    if (!process.env.OPENAI_API_KEY) { console.log(color(C.red, "  OPENAI_API_KEY not set")); return; }
    if (!currentCourse) { console.log(color(C.red, "  No course loaded. Run 'process <url>' or 'course <id>' first.")); return; }
    const state = load(currentCourse);
    if (!state) { console.log(color(C.red, `  Course "${currentCourse}" not found on disk.`)); return; }

    const question = rest.join(" ");
    if (!question) { console.log(color(C.red, "  Usage: ask <question>")); return; }

    const engine = createRetrievalQaEngine({ chunks: state.chunks, artifacts: state.artifacts, llm: llm!, maxContextChunks: 4 });
    console.log(color(C.dim, "  Searching..."));
    const answer = await engine.ask({ courseId: currentCourse, question });

    if (answer.status === "insufficient_context") {
      console.log(color(C.yellow, `  ${answer.answer}`));
      return;
    }
    console.log(`\n  ${answer.answer}\n`);
    if (answer.citations.length > 0) {
      console.log(color(C.dim, `  Citations (${answer.citations.length}):`));
      answer.citations.forEach((c: any) => console.log(color(C.dim, `    ${c.videoId} [${fmt(c.startSeconds)}-${fmt(c.endSeconds)}]`)));
    }
    if (answer.replayRanges.length > 0) {
      console.log(color(C.dim, `  Replay:`));
      answer.replayRanges.forEach((r: any) => console.log(color(C.dim, `    ${r.videoId} [${fmt(r.startSeconds)}-${fmt(r.endSeconds)}]`)));
    }
    if (answer.followUpQuestions.length > 0) {
      console.log(color(C.dim, "  Follow-ups:"));
      answer.followUpQuestions.forEach((q: string) => console.log(color(C.dim, `    - ${q}`)));
    }
    return;
  }

  // Unknown: try as a raw question if a course is loaded
  if (currentCourse) {
    console.log(color(C.yellow, `  Unknown command "${cmd}". To ask a question use: ask ${trimmed}`));
    return;
  }
  console.log(color(C.red, `  Unknown command: ${cmd}. Type 'help' for commands.`));
}

function fmt(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}

// ---------------------------------------------------------------------------
// Entry — always TUI
// ---------------------------------------------------------------------------
console.log("");
console.log(`  ${color(C.bold, "LearnFrame")} ${color(C.dim, "— YouTube to learning pipeline")}`);
console.log(color(C.dim, "  Type 'help' for commands, 'process <url>' to start, 'exit' to quit."));
console.log("");

rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt(color(C.cyan, "› "));
rl.prompt();

rl.on("line", async (line) => {
  try { rl?.pause(); await handle(line); } catch (e: any) { console.log(color(C.red, `  Error: ${e.message}`)); }
  rl?.resume();
  rl?.prompt();
});

rl.on("close", () => {
  console.log("");
  process.exit(0);
});
