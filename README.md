# LearnFrame

Turn YouTube videos into local study material and timestamp-aware chat.

LearnFrame is a YouTube-first learning toolkit. Give it a public YouTube video, and it extracts captions, chunks the transcript, generates study artifacts, stores the course locally, and lets you ask questions that cite the video timestamp they came from.

It ships as both:

- A terminal app for learners who want to chat with a video from their shell.
- A TypeScript SDK for builders who want to add YouTube learning workflows to their own product.

## Who Is This For?

Use LearnFrame if you are:

- Learning from long YouTube lectures, tutorials, talks, or course videos and want notes plus grounded answers.
- Building an education product that needs transcript extraction, chunking, study artifacts, and timestamp citations.
- Prototyping a NotebookLM-style experience for YouTube content, but want local storage and OSS primitives.
- Creating developer tools, agents, or courseware that need structured learning artifacts from videos.

LearnFrame is probably not the right tool if you need a hosted UI, private-video auth, a managed database, or production-grade multi-user accounts today. The current package is a local-first CLI and SDK foundation.

## What It Does

- Processes a YouTube video into a local course.
- Uses `yt-dlp` captions first, so most videos avoid paid transcription.
- Falls back to Whisper only when you explicitly allow it.
- Generates artifacts like notes, summaries, flashcards, glossaries, quizzes, syllabi, study plans, and prerequisite maps.
- Lets you ask questions in chat mode with timestamp citations.
- Opens the video at cited timestamps.
- Exports course data as JSON, Markdown, and HTML artifacts.
- Stores local course state under `~/.learnframe/courses`.

## Install

Requires Node.js 20 or newer.

```bash
npm install -g learnframe
```

Optional but recommended system tools:

```bash
brew install yt-dlp ffmpeg mpv
```

- `yt-dlp` extracts YouTube captions.
- `ffmpeg` enables frame extraction and transcription-related workflows.
- `mpv` enables terminal video playback with `/video --backend=tct`.

Set your OpenAI key for artifact generation and chat:

```bash
export OPENAI_API_KEY="sk-..."
```

## Quick Start: CLI

Start the app:

```bash
learnframe
```

Process a video:

```text
cmd › process https://www.youtube.com/watch?v=pmoDeA3RBZY
```

Then ask questions naturally:

```text
youtube-course:playlist:pmoDeA3RBZY › what is this video about?
```

Useful chat commands:

```text
/status                         show current course metadata
/notes                          open notes artifact in the browser
/flashcards                     open flashcards artifact in the browser
/infographic                    open infographic artifact in the browser
/play 02:30                     open the YouTube video at a timestamp
/video 02:30 --backend=browser  open/play video using a selected backend
/video 02:30 --backend=tct      play video as terminal color blocks with mpv
/stop                           stop terminal playback
/export                         export JSON and Markdown
/quit                           leave chat mode
```

Load a previous course:

```text
cmd › courses
cmd › course youtube-course:playlist:pmoDeA3RBZY
```

If you just upgraded LearnFrame, restart the running CLI process. A shell that was already open keeps using the old code until it exits.

## CLI Storage

Processed courses are stored locally:

```text
~/.learnframe/courses
```

This makes repeat runs faster and lets `course <id>` reload previous work. Course IDs may contain colons, for example `youtube-course:playlist:pmoDeA3RBZY`; LearnFrame preserves the full ID on disk.

## SDK Usage

Install in a project:

```bash
npm install learnframe
```

Minimal TypeScript example:

```ts
import {
  createLearnFrame,
  createInMemoryStorage,
  createYoutubeDataApiSourceResolver,
  YtDlpTranscriptProvider,
  createLowCostArtifactEngine,
  type LlmAdapter,
} from "learnframe";

const storage = createInMemoryStorage();

const llm: LlmAdapter = {
  async generateStructured(request) {
    // Connect this to your model provider.
    // Return JSON that matches LearnFrame's schema for request.task.
    throw new Error(`Implement LLM task: ${request.task}`);
  },
};

const sdk = createLearnFrame({
  storage,
  sourceResolver: createYoutubeDataApiSourceResolver({
    apiKey: process.env.YOUTUBE_API_KEY!,
  }),
  transcriptProvider: new YtDlpTranscriptProvider({ storage }),
  artifactEngine: createLowCostArtifactEngine({ storage, llm }),
  llm,
});

const course = await sdk.process({
  source: {
    type: "video",
    url: "https://www.youtube.com/watch?v=pmoDeA3RBZY",
  },
  outputs: ["notes", "summary", "flashcards"],
});

console.log(course.courseId);
console.log(course.artifacts.map((artifact) => artifact.kind));
```

For timestamp-aware Q&A, configure a retrieval QA engine with stored chunks and an LLM adapter:

```ts
import { createRetrievalQaEngine } from "learnframe";

const qa = createRetrievalQaEngine({
  chunks: course.chunks,
  artifacts: course.artifacts,
  llm,
});

const answer = await qa.ask({
  courseId: course.courseId,
  question: "What is the main idea?",
});

console.log(answer.answer);
console.log(answer.citations);
```

## Core Concepts

**Source resolver**
Turns a YouTube video or playlist URL into normalized course and video metadata. The SDK includes an in-memory resolver for tests/prototypes and a YouTube Data API resolver for real playlists.

**Transcript provider**
Extracts captions for each video. `YtDlpTranscriptProvider` uses `yt-dlp` and returns timestamped transcript segments.

**Artifact engine**
Generates structured study outputs from transcript chunks. The built-in low-cost engine uses schema-checked LLM calls and caching.

**Storage adapter**
Persists course state, transcript cache, source-resolution cache, and generated artifacts. The package includes in-memory storage; apps can provide their own database, file store, or object store.

**Retrieval QA**
Selects relevant transcript chunks, asks the LLM to answer only from that context, and rejects ungrounded answers that do not cite retrieved timestamp ranges.

## Supported Artifact Kinds

```ts
"transcript"
"summary"
"notes"
"syllabus"
"qa"
"glossary"
"quiz"
"flashcards"
"study_plan"
"prerequisite_map"
```

The CLI defaults to `notes,summary` unless you pass `--outputs`:

```text
cmd › process https://www.youtube.com/watch?v=pmoDeA3RBZY --outputs notes,summary,flashcards,quiz
```

## Requirements And Limitations

- Public YouTube videos work best.
- Caption extraction depends on `yt-dlp` and the captions available for that video.
- LLM generation requires `OPENAI_API_KEY` in the CLI.
- Whisper fallback is opt-in with `--whisper`; it may cost money.
- The CLI is local-first and single-user.
- Terminal video playback depends on your terminal and installed tools.
- If no embeddings adapter is configured, QA uses nearby/fallback transcript chunks instead of semantic embedding search.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The package is ESM-only and targets Node.js 20+.

## Contributing

Good contributions are focused and user-facing. Useful areas:

- More storage adapters.
- Better source resolvers.
- More reliable transcript fallback paths.
- Improved artifact schemas.
- Better terminal UX for video and chat.
- Documentation with real examples.

Before opening a PR, run:

```bash
npm test
npm run typecheck
npm run build
```

## License

MIT
