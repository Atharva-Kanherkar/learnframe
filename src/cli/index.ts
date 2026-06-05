#!/usr/bin/env node
import {
  createInMemoryStorage,
  createYoutubeDataApiSourceResolver,
  YtDlpTranscriptProvider,
  WhisperTranscriptProvider,
  chunkTranscript,
  createLowCostArtifactEngine,
  createRetrievalQaEngine,
  parseYoutubeUrl,
  createLearnFrame,
  answerSchema,
  type ArtifactKind,
  type LlmAdapter,
  type LlmRequest,
  type RetrievalQaEngine,
  type TranscriptChunk,
  type Transcript,
} from "../index.js";

// ---------------------------------------------------------------------------
// OpenAI LLM adapter (runs on native fetch, no extra deps)
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

// Embedded JSON schemas for structured output (keeps CLI dependency-free)
function schemasForTask(task: string): Record<string, unknown> | undefined {
  if (task === "chunk-notes") return CHUNK_NOTES_SCHEMA;
  if (task === "video-summary") return VIDEO_SUMMARY_SCHEMA;
  if (task === "playlist-syllabus") return SYLLABUS_SCHEMA;
  if (task === "glossary") return GLOSSARY_SCHEMA;
  if (task === "quiz") return QUIZ_SCHEMA;
  if (task === "flashcards") return FLASHCARDS_SCHEMA;
  if (task === "study-plan") return STUDY_PLAN_SCHEMA;
  if (task === "prerequisite-map") return PREREQ_SCHEMA;
  if (task === "retrieval-qa-answer") return QA_ANSWER_SCHEMA;
  return undefined;
}

const CITATION = {
  type: "object",
  additionalProperties: false,
  required: ["videoId", "startSeconds", "endSeconds", "chunkId"],
  properties: { videoId: { type: "string" }, startSeconds: { type: "number" }, endSeconds: { type: "number" }, chunkId: { type: "string" } },
};

const RANGE = {
  type: "object",
  additionalProperties: false,
  required: ["videoId", "startSeconds", "endSeconds"],
  properties: { videoId: { type: "string" }, startSeconds: { type: "number" }, endSeconds: { type: "number" } },
};

const CHUNK_NOTES_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["chunkId", "videoId", "summary", "keyPoints", "concepts", "citations"],
  properties: { chunkId: { type: "string" }, videoId: { type: "string" }, summary: { type: "string" }, keyPoints: { type: "array", items: { type: "string" } }, concepts: { type: "array", items: { type: "string" } }, citations: { type: "array", items: CITATION } },
} as const;

const VIDEO_SUMMARY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["videoId", "summary", "keyPoints", "citations"],
  properties: { videoId: { type: "string" }, summary: { type: "string" }, keyPoints: { type: "array", items: { type: "string" } }, citations: { type: "array", items: CITATION } },
} as const;

const SYLLABUS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["courseId", "title", "modules"],
  properties: { courseId: { type: "string" }, title: { type: "string" }, modules: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "summary", "videoIds", "outcomes"], properties: { title: { type: "string" }, summary: { type: "string" }, videoIds: { type: "array", items: { type: "string" } }, outcomes: { type: "array", items: { type: "string" } } } } } },
} as const;

const GLOSSARY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["terms"],
  properties: { terms: { type: "array", items: { type: "object", additionalProperties: false, required: ["term", "definition", "citations"], properties: { term: { type: "string" }, definition: { type: "string" }, citations: { type: "array", items: CITATION } } } } },
} as const;

const QUIZ_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["questions"],
  properties: { questions: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "choices", "answer", "explanation", "citations"], properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" }, minItems: 2 }, answer: { type: "string" }, explanation: { type: "string" }, citations: { type: "array", items: CITATION } } } } },
} as const;

const FLASHCARDS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["cards"],
  properties: { cards: { type: "array", items: { type: "object", additionalProperties: false, required: ["front", "back", "citations"], properties: { front: { type: "string" }, back: { type: "string" }, citations: { type: "array", items: CITATION } } } } },
} as const;

const STUDY_PLAN_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["courseId", "steps"],
  properties: { courseId: { type: "string" }, steps: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "objective", "videoIds"], properties: { title: { type: "string" }, objective: { type: "string" }, videoIds: { type: "array", items: { type: "string" } } } } } },
} as const;

const PREREQ_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["prerequisites"],
  properties: { prerequisites: { type: "array", items: { type: "object", additionalProperties: false, required: ["concept", "requiredBefore", "reason", "citations"], properties: { concept: { type: "string" }, requiredBefore: { type: "array", items: { type: "string" } }, reason: { type: "string" }, citations: { type: "array", items: CITATION } } } } },
} as const;

const QA_ANSWER_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["answer", "status", "citations", "replayRanges", "followUpQuestions", "confidence"],
  properties: { answer: { type: "string" }, status: { type: "string", enum: ["answered", "insufficient_context"] }, citations: { type: "array", items: { ...CITATION, properties: { ...(CITATION as any).properties, text: { type: "string" } } } }, replayRanges: { type: "array", items: RANGE }, followUpQuestions: { type: "array", items: { type: "string" } }, confidence: { type: "object", additionalProperties: false, required: ["score", "reason"], properties: { score: { type: "number" }, reason: { type: "string" } } } },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireApiKey(): string {
  return process.env.OPENAI_API_KEY || "";
}

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

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

function getYtDlpPath(): string {
  const paths = [
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "yt-dlp",
  ];
  for (const p of paths) {
    try {
      // Don't actually run, just try the known paths
      // The provider will handle the binary resolution
    } catch {}
    // Just use "yt-dlp" as default and let PATH handle it
  }
  return "yt-dlp";
}

async function resolveSource(url: string, apiKey: string | undefined) {
  const storage = createInMemoryStorage();
  const parsed = parseYoutubeUrl(url);
  printJson({ parsed });
}

async function extractTranscript(url: string, audioApiKey: string | undefined, opts: { language?: string; useWhisper?: boolean }) {
  const storage = createInMemoryStorage();
  const ytDlpTranscript = new YtDlpTranscriptProvider({ storage, timeoutMs: 120_000 });

  // Try captions first
  const videoMeta = { id: parseYoutubeUrl(url).videoId ?? url, url, availability: "available" as const };
  let transcript = await ytDlpTranscript.getTranscript(videoMeta, { language: opts.language ?? "en" });

  if (transcript.status === "missing" && opts.useWhisper && audioApiKey) {
    console.error("No captions found. Falling back to OpenAI Whisper transcription...");
    const whisper = new WhisperTranscriptProvider({ apiKey: audioApiKey, storage, timeoutMs: 300_000 });
    transcript = await whisper.getTranscript(videoMeta, { language: opts.language, allowPaidTranscription: true });
  }

  printJson({
    status: transcript.status,
    segmentCount: transcript.segments.length,
    firstWords: transcript.segments.slice(0, 5).map((s) => s.text).join(" "),
    provenance: transcript.provenance ?? null,
    segments: transcript.segments,
  });
}

async function generateArtifacts(url: string, apiKey: string, outputFlags: string) {
  const kinds = (outputFlags || "notes,summary").split(",").map((s) => s.trim()) as ArtifactKind[];
  const llm = createOpenAiLlmAdapter(apiKey);
  const storage = createInMemoryStorage();
  const transcript = await getTranscriptForUrl(url, apiKey, storage);

  if (transcript.status !== "available" || transcript.segments.length === 0) {
    die("Transcript is not available. Cannot generate artifacts without captions.");
  }

  const chunks = chunkTranscript(transcript);
  console.error(`Chunked into ${chunks.length} chunks. Generating artifacts...`);

  const engine = createLowCostArtifactEngine({ llm, storage, maxConcurrentChunkNotes: 3 });
  const artifacts = await engine.generate({
    courseId: parseYoutubeUrl(url).videoId ?? url,
    chunks,
    outputs: kinds,
  });

  printJson(artifacts.map((a) => ({ kind: a.kind, promptVersion: a.promptVersion, modelRole: a.modelRole, data: a.data })));
}

async function askQuestion(courseId: string, question: string, apiKey: string, opts: { videoId?: string; timestamp?: number }) {
  const llm = createOpenAiLlmAdapter(apiKey);

  // Build a QA engine — consumer provides chunks & artifacts
  // For a real CLI we'd persist chunks, but for now create an engine with empty
  // chunks that returns insufficient_context with guidance
  const qa: RetrievalQaEngine = {
    async ask(input) {
      // For now: send directly to LLM without retrieval grounding
      // A real session would store chunks/artifacts from a prior `process` step
      const result = await llm.generateStructured({
        task: "retrieval-qa-answer",
        promptVersion: "retrieval-qa-v1",
        modelRole: "medium",
        input: {
          question: input.question,
          courseId: input.courseId,
          videoId: input.videoId,
          timestampSeconds: input.timestampSeconds,
          contextChunks: [],
          courseContext: [],
          instructions: "Return insufficient_context because no course content has been loaded.",
        },
      });
      return result as any;
    },
  };

  const sdk = createLearnFrame({ sourceResolver: dummyResolver(), storage: createInMemoryStorage(), qa });
  const answer = await sdk.ask({ courseId, videoId: opts.videoId, timestampSeconds: opts.timestamp, question });
  printJson(answer);
}

async function processFull(url: string, apiKey: string, outputFlags: string) {
  const kinds = (outputFlags || "notes,summary,syllabus").split(",").map((s) => s.trim()) as ArtifactKind[];
  const llm = createOpenAiLlmAdapter(apiKey);
  const storage = createInMemoryStorage();
  const transcript = await getTranscriptForUrl(url, apiKey, storage);

  if (transcript.status !== "available" || transcript.segments.length === 0) {
    die("Transcript is not available. Cannot process without captions.");
  }

  const chunks = chunkTranscript(transcript);
  console.error(`Resolved ${transcript.segments.length} transcript segments → ${chunks.length} chunks.\nGenerating: ${kinds.join(", ")}...`);

  const engine = createLowCostArtifactEngine({ llm, storage, maxConcurrentChunkNotes: 3 });
  const artifacts = await engine.generate({ courseId: parseYoutubeUrl(url).videoId ?? url, chunks, outputs: kinds });

  const answerEngine = createRetrievalQaEngine({ chunks, artifacts, llm, maxContextChunks: 4 });
  printJson({
    transcriptStatus: transcript.status,
    segmentCount: transcript.segments.length,
    chunkCount: chunks.length,
    artifacts: artifacts.map((a) => ({ kind: a.kind, promptVersion: a.promptVersion, modelRole: a.modelRole, data: a.data })),
    qaReady: true,
  });
}

async function getTranscriptForUrl(url: string, apiKey: string | undefined, storage: ReturnType<typeof createInMemoryStorage>): Promise<Transcript> {
  const videoMeta = { id: parseYoutubeUrl(url).videoId ?? url, url, availability: "available" as const };
  const ytDlpTranscript = new YtDlpTranscriptProvider({ storage, timeoutMs: 120_000 });
  let transcript = await ytDlpTranscript.getTranscript(videoMeta, { language: "en" });

  if (transcript.status === "missing" && apiKey) {
    console.error("No captions found. Falling back to OpenAI Whisper...");
    const whisper = new WhisperTranscriptProvider({ apiKey, storage, timeoutMs: 300_000 });
    transcript = await whisper.getTranscript(videoMeta, { allowPaidTranscription: true });
  }

  return transcript;
}

function dummyResolver() {
  return { resolve: async () => { throw new Error("not used"); } } as any;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

const usage = `LearnFrame CLI — YouTube-to-learning pipeline

Usage: learnframe <command> [options]

Commands:
  resolve   <url>                              Parse and resolve YouTube URL
  transcript <url> [--language en] [--whisper] Extract captions (or transcribe with --whisper)
  generate  <url> --outputs notes,summary,...  Generate learning artifacts
  ask       <courseId> <question> [--video-id] [--timestamp] Ask a question
  process   <url> --outputs notes,summary,...  Full pipeline: transcript → chunk → generate

Environment:
  OPENAI_API_KEY    Required for generate, ask, process, and --whisper transcript

Examples:
  learnframe resolve "https://www.youtube.com/watch?v=abc123"
  learnframe transcript "https://www.youtube.com/watch?v=abc123"
  learnframe generate "https://www.youtube.com/watch?v=abc123" --outputs notes,summary
  learnframe ask course-1 "What is gradient descent?" --video-id abc123 --timestamp 300
  learnframe process "https://www.youtube.com/watch?v=abc123" --outputs notes,summary,syllabus
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
    await resolveSource(url, apiKey);
    break;
  }
  case "transcript": {
    const url = args[1];
    if (!url) die("Usage: learnframe transcript <url> [--language en] [--whisper]");
    await extractTranscript(url, apiKey, {
      language: flag(args, "language"),
      useWhisper: hasFlag(args, "whisper"),
    });
    break;
  }
  case "generate": {
    const url = args[1];
    if (!url) die("Usage: learnframe generate <url> --outputs notes,summary,...");
    if (!apiKey) die("OPENAI_API_KEY environment variable is required for artifact generation.");
    await generateArtifacts(url, apiKey, requireFlag(args, "outputs"));
    break;
  }
  case "ask": {
    const courseId = args[1];
    const question = args[2];
    if (!courseId || !question) die("Usage: learnframe ask <courseId> <question> [--video-id] [--timestamp]");
    if (!apiKey) die("OPENAI_API_KEY is required.");
    await askQuestion(courseId, question, apiKey, {
      videoId: flag(args, "video-id"),
      timestamp: flag(args, "timestamp") ? Number(flag(args, "timestamp")) : undefined,
    });
    break;
  }
  case "process": {
    const url = args[1];
    if (!url) die("Usage: learnframe process <url> --outputs notes,summary,...");
    if (!apiKey) die("OPENAI_API_KEY is required.");
    await processFull(url, apiKey, requireFlag(args, "outputs"));
    break;
  }
  default:
    die(`Unknown command: ${command}\n${usage}`);
}
