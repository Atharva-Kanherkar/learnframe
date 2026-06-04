# YouTube Learning SDK

YouTube Learning SDK is a YouTube-first learning engine for turning public videos
and playlists into transcripts, summaries, specialized notes, syllabi,
explanations, quizzes, and timestamp-aware AI help.

The project optimizes for three things:

1. Cost: caption-first, cache-heavy, hierarchical LLM calls.
2. Latency: resumable pipelines, parallel video processing, streaming progress.
3. Accuracy: timestamp citations, transcript provenance, schema-checked outputs.

The SDK is designed to be consumed by Skillware and by any other app that wants
to embed YouTube learning workflows.

```ts
import { createYoutubeLearningSdk } from "youtube-learning-sdk";

const sdk = createYoutubeLearningSdk({ llm, storage });

const course = await sdk.process({
  source: { type: "playlist", url: "https://youtube.com/playlist?list=..." },
  outputs: ["transcripts", "summaries", "notes", "syllabus", "qa"],
});

const answer = await sdk.ask({
  courseId: course.id,
  question: "What is happening at 10:12?",
  videoId: course.videos[0].id,
  timestampSeconds: 612,
});
```

## Current Status

Planning repo. See [docs/plan.md](docs/plan.md) for the implementation plan.

## Core Product Idea

- Give the SDK a YouTube video or playlist.
- A video is treated as a playlist of one.
- Extract captions first using `yt-dlp`.
- Use paid transcription only when explicitly enabled.
- Generate learning artifacts using cheap, structured, cached LLM calls.
- Let consuming apps embed/play the YouTube video and attach an "Ask" button to
  the current playback timestamp.

## License

TBD.
