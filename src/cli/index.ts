#!/usr/bin/env node
import {
  createInMemoryStorage,
  createInMemorySourceResolver,
  YtDlpTranscriptProvider,
  WhisperTranscriptProvider,
  chunkTranscript,
  createLowCostArtifactEngine,
  createRetrievalQaEngine,
  parseYoutubeUrl,
  createLearnFrame,
  type ArtifactKind,
  type LlmAdapter,
  type LlmRequest,
  type RetrievalQaEngine,
  type Transcript,
} from "../index.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// OpenAI LLM adapter
// ---------------------------------------------------------------------------

function createOpenAiLlmAdapter(apiKey: string, model: string = "gpt-4o-mini"): LlmAdapter {
  return {
    async generateStructured<T>(request: LlmRequest): Promise<T> {
      const schema = schemasForTask(request.task);
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "Return only valid JSON matching the schema. Preserve timestamp citations and video/chunk IDs exactly as provided.",
            },
            { role: "user", content: JSON.stringify(request.input) },
          ],
          response_format: schema
            ? ({ type: "json_schema", json_schema: { name: request.task.replace(/-/g, "_"), strict: true, schema } } as any)
            : { type: "json_object" },
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OpenAI ${response.status}: ${body}`);
      }
      const json: any = await response.json();
      return JSON.parse(json.choices[0].message.content) as T;
    },
  };
}

// ---------------------------------------------------------------------------
// JSON schemas (embedded, no dependency drift)
// ---------------------------------------------------------------------------

function schemasForTask(task: string): Record<string, unknown> | undefined {
  const schema = SCHEMAS[task];
  return schema as Record<string, unknown> | undefined;
}

const CIT = {
  type: "object",
  additionalProperties: false,
  required: ["videoId", "startSeconds", "endSeconds", "chunkId"],
  properties: { videoId: { type: "string" }, startSeconds: { type: "number" }, endSeconds: { type: "number" }, chunkId: { type: "string" } },
};

// QA citation — text is optional, modelled as required nullable so strict mode accepts it
const QA_CIT = {
  type: "object",
  additionalProperties: false,
  required: ["videoId", "startSeconds", "endSeconds", "chunkId", "text"],
  properties: {
    videoId: { type: "string" },
    startSeconds: { type: "number" },
    endSeconds: { type: "number" },
    chunkId: { type: "string" },
    text: { type: "string" },
  },
};

const RANGE = {
  type: "object",
  additionalProperties: false,
  required: ["videoId", "startSeconds", "endSeconds"],
  properties: { videoId: { type: "string" }, startSeconds: { type: "number" }, endSeconds: { type: "number" } },
};

const SCHEMAS: Record<string, unknown> = {
  "chunk-notes": {
    type: "object", additionalProperties: false,
    required: ["chunkId", "videoId", "summary", "keyPoints", "concepts", "citations"],
    properties: { chunkId: { type: "string" }, videoId: { type: "string" }, summary: { type: "string" }, keyPoints: { type: "array", items: { type: "string" } }, concepts: { type: "array", items: { type: "string" } }, citations: { type: "array", items: CIT } },
  },
  "video-summary": {
    type: "object", additionalProperties: false,
    required: ["videoId", "summary", "keyPoints", "citations"],
    properties: { videoId: { type: "string" }, summary: { type: "string" }, keyPoints: { type: "array", items: { type: "string" } }, citations: { type: "array", items: CIT } },
  },
  "playlist-syllabus": {
    type: "object", additionalProperties: false,
    required: ["courseId", "title", "modules"],
    properties: { courseId: { type: "string" }, title: { type: "string" }, modules: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "summary", "videoIds", "outcomes"], properties: { title: { type: "string" }, summary: { type: "string" }, videoIds: { type: "array", items: { type: "string" } }, outcomes: { type: "array", items: { type: "string" } } } } } },
  },
  "glossary": {
    type: "object", additionalProperties: false,
    required: ["terms"],
    properties: { terms: { type: "array", items: { type: "object", additionalProperties: false, required: ["term", "definition", "citations"], properties: { term: { type: "string" }, definition: { type: "string" }, citations: { type: "array", items: CIT } } } } },
  },
  "quiz": {
    type: "object", additionalProperties: false,
    required: ["questions"],
    properties: { questions: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "choices", "answer", "explanation", "citations"], properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" }, minItems: 2 }, answer: { type: "string" }, explanation: { type: "string" }, citations: { type: "array", items: CIT } } } } },
  },
  "flashcards": {
    type: "object", additionalProperties: false,
    required: ["cards"],
    properties: { cards: { type: "array", items: { type: "object", additionalProperties: false, required: ["front", "back", "citations"], properties: { front: { type: "string" }, back: { type: "string" }, citations: { type: "array", items: CIT } } } } },
  },
  "study-plan": {
    type: "object", additionalProperties: false,
    required: ["courseId", "steps"],
    properties: { courseId: { type: "string" }, steps: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "objective", "videoIds"], properties: { title: { type: "string" }, objective: { type: "string" }, videoIds: { type: "array", items: { type: "string" } } } } } },
  },
  "prerequisite-map": {
    type: "object", additionalProperties: false,
    required: ["prerequisites"],
    properties: { prerequisites: { type: "array", items: { type: "object", additionalProperties: false, required: ["concept", "requiredBefore", "reason", "citations"], properties: { concept: { type: "string" }, requiredBefore: { type: "array", items: { type: "string" } }, reason: { type: "string" }, citations: { type: "array", items: CIT } } } } },
  },
  "retrieval-qa-answer": {
    type: "object", additionalProperties: false,
    required: ["answer", "status", "citations", "replayRanges", "followUpQuestions", "confidence"],
    properties: { answer: { type: "string" }, status: { type: "string", enum: ["answered", "insufficient_context"] }, citations: { type: "array", items: QA_CIT }, replayRanges: { type: "array", items: RANGE }, followUpQuestions: { type: "array", items: { type: "string" } }, confidence: { type: "object", additionalProperties: false, required: ["score", "reason"], properties: { score: { type: "number" }, reason: { type: "string" } } } },
  },
};

// ---------------------------------------------------------------------------
// Course persistence (so `process` → `ask` survives CLI exits)
// ---------------------------------------------------------------------------

const COURSE_DIR = join(homedir(), ".learnframe", "courses");

function coursePath(courseId: string): string {
  return join(COURSE_DIR, `${courseId}.json`);
}

type CourseState = {
  courseId: string;
  url: string;
  createdAt: string;
  chunks: any[];
  artifacts: any[];
};

function saveCourseState(state: CourseState): void {
  mkdirSync(COURSE_DIR, { recursive: true });
  writeFileSync(coursePath(state.courseId), JSON.stringify(state, null, 2), "utf8");
}

function loadCourseState(courseId: string): CourseState | undefined {
  const path = coursePath(courseId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as CourseState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < args.length) return args[index + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function requireFlag(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) die(`Missing required flag --${name}`);
  return value;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireApiKey(): string {
  return process.env.OPENAI_API_KEY || "";
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdResolve(url: string) {
  const parsed = parseYoutubeUrl(url);
  const resolver = createInMemorySourceResolver({
    videos: { [parsed.videoId ?? url]: { id: parsed.videoId ?? url, url: parsed.canonicalUrl, title: "YouTube video" } },
  });
  const result = await resolver.resolve(
    { type: "video", url: parsed.canonicalUrl, videoId: parsed.videoId },
    { storage: createInMemoryStorage(), reportProgress: async () => {} },
  );
  printJson(result);
}

async function cmdTranscript(url: string, apiKey: string | undefined, opts: { language?: string; useWhisper?: boolean }) {
  const transcript = await getTranscriptForUrl(url, apiKey, createInMemoryStorage(), opts);
  printJson({
    status: transcript.status,
    segmentCount: transcript.segments.length,
    firstWords: transcript.segments.slice(0, 5).map((s) => s.text).join(" "),
    provenance: transcript.provenance ?? null,
    segments: transcript.segments,
  });
}

async function cmdGenerate(url: string, apiKey: string, outputFlags: string) {
  const kinds = parseOutputs(outputFlags);
  const llm = createOpenAiLlmAdapter(apiKey);
  const storage = createInMemoryStorage();
  const transcript = await getTranscriptForUrl(url, apiKey, storage, {});

  if (transcript.status !== "available" || transcript.segments.length === 0) {
    die("Transcript is not available. Cannot generate artifacts without captions.");
  }

  const chunks = chunkTranscript(transcript);
  console.error(`Chunked into ${chunks.length} chunks. Generating artifacts...`);

  const engine = createLowCostArtifactEngine({ llm, storage, maxConcurrentChunkNotes: 3 });
  const artifacts = await engine.generate({ courseId: parseYoutubeUrl(url).videoId ?? url, chunks, outputs: kinds });
  printJson(artifacts.map((a) => ({ kind: a.kind, promptVersion: a.promptVersion, modelRole: a.modelRole, data: a.data })));
}

async function cmdAsk(courseId: string, question: string, apiKey: string, opts: { videoId?: string; timestamp?: number }) {
  const llm = createOpenAiLlmAdapter(apiKey);
  const state = loadCourseState(courseId);

  if (!state) {
    console.error(`No course state found for "${courseId}". Run "learnframe process" first.`);
    process.exit(1);
  }

  const engine = createRetrievalQaEngine({ chunks: state.chunks as any[], artifacts: state.artifacts as any[], llm, maxContextChunks: 4 });
  const answer = await engine.ask({ courseId, videoId: opts.videoId, timestampSeconds: opts.timestamp, question });
  printJson(answer);
}

async function cmdProcess(url: string, apiKey: string, outputFlags: string) {
  const kinds = parseOutputs(outputFlags);
  const llm = createOpenAiLlmAdapter(apiKey);
  const storage = createInMemoryStorage();
  const transcript = await getTranscriptForUrl(url, apiKey, storage, {});

  if (transcript.status !== "available" || transcript.segments.length === 0) {
    die("Transcript is not available. Cannot process without captions.");
  }

  const chunks = chunkTranscript(transcript);
  console.error(`Resolved ${transcript.segments.length} transcript segments → ${chunks.length} chunks.\nGenerating: ${kinds.join(", ")}...`);

  const courseId = parseYoutubeUrl(url).videoId ?? url;
  const engine = createLowCostArtifactEngine({ llm, storage, maxConcurrentChunkNotes: 3 });
  const artifacts = await engine.generate({ courseId, chunks, outputs: kinds });

  // Persist so `ask` can reload
  saveCourseState({ courseId, url, createdAt: new Date().toISOString(), chunks, artifacts });

  printJson({
    courseId,
    transcriptStatus: transcript.status,
    segmentCount: transcript.segments.length,
    chunkCount: chunks.length,
    artifacts: artifacts.map((a) => ({ kind: a.kind, promptVersion: a.promptVersion, modelRole: a.modelRole, data: a.data })),
    savedTo: coursePath(courseId),
    qaReady: true,
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseOutputs(outputFlags: string): ArtifactKind[] {
  return outputFlags.split(",").map((s) => s.trim()) as ArtifactKind[];
}

async function getTranscriptForUrl(url: string, apiKey: string | undefined, storage: ReturnType<typeof createInMemoryStorage>, opts: { language?: string; useWhisper?: boolean }): Promise<Transcript> {
  const videoMeta = { id: parseYoutubeUrl(url).videoId ?? url, url, availability: "available" as const };
  const ytDlpTranscript = new YtDlpTranscriptProvider({ storage, timeoutMs: 120_000 });
  let transcript = await ytDlpTranscript.getTranscript(videoMeta, { language: opts.language ?? "en" });

  if (transcript.status === "missing" && (opts.useWhisper || hasFlag(process.argv, "--whisper")) && apiKey) {
    console.error("No captions found. Falling back to OpenAI Whisper...");
    const whisper = new WhisperTranscriptProvider({ apiKey, storage, timeoutMs: 300_000 });
    transcript = await whisper.getTranscript(videoMeta, { language: opts.language, allowPaidTranscription: true });
  }

  return transcript;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

const usage = `LearnFrame CLI — YouTube-to-learning pipeline

Usage: learnframe <command> [options]

Commands:
  resolve   <url>                              Resolve YouTube URL to video metadata
  transcript <url> [--language en] [--whisper] Extract captions (or transcribe with --whisper)
  generate  <url> --outputs notes,summary,...  Generate learning artifacts
  ask       <courseId> <question> [--video-id] [--timestamp] Ask a question (requires prior "process")
  process   <url> --outputs notes,summary,...  Full pipeline: resolve → transcript → chunk → generate → save

Environment:
  OPENAI_API_KEY    Required for generate, ask, process, and --whisper transcript

Examples:
  learnframe resolve "https://www.youtube.com/watch?v=abc123"
  learnframe transcript "https://www.youtube.com/watch?v=abc123"
  learnframe process "https://www.youtube.com/watch?v=abc123" --outputs notes,summary,syllabus
  learnframe ask abc123 "What is gradient descent?" --timestamp 300
`;

if (!command || command === "--help" || command === "-h") {
  console.log(usage);
  process.exit(0);
}

const apiKey = requireApiKey();

switch (command) {
  case "resolve": {
    const url = args[1];
    if (!url) die("Usage: learnframe resolve <url>");
    await cmdResolve(url);
    break;
  }
  case "transcript": {
    const url = args[1];
    if (!url) die("Usage: learnframe transcript <url> [--language en] [--whisper]");
    await cmdTranscript(url, apiKey, {
      language: flag(args, "language"),
      useWhisper: hasFlag(args, "whisper"),
    });
    break;
  }
  case "generate": {
    const url = args[1];
    if (!url) die("Usage: learnframe generate <url> --outputs notes,summary,...");
    if (!apiKey) die("OPENAI_API_KEY is required.");
    await cmdGenerate(url, apiKey, requireFlag(args, "outputs"));
    break;
  }
  case "ask": {
    const courseId = args[1];
    const question = args[2];
    if (!courseId || !question) die("Usage: learnframe ask <courseId> <question> [--video-id] [--timestamp]");
    if (!apiKey) die("OPENAI_API_KEY is required.");
    await cmdAsk(courseId, question, apiKey, {
      videoId: flag(args, "video-id"),
      timestamp: flag(args, "timestamp") ? Number(flag(args, "timestamp")) : undefined,
    });
    break;
  }
  case "process": {
    const url = args[1];
    if (!url) die("Usage: learnframe process <url> --outputs notes,summary,...");
    if (!apiKey) die("OPENAI_API_KEY is required.");
    await cmdProcess(url, apiKey, requireFlag(args, "outputs"));
    break;
  }
  default:
    die(`Unknown command: ${command}\n${usage}`);
}
