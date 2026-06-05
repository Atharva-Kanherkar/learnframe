import { describe, expect, it } from "vitest";
import type {
  Artifact,
  ArtifactKind,
  SourceResolver,
  Transcript,
  TranscriptProvider,
  VideoMetadata,
  YoutubeSource,
} from "../../src/contracts.js";
import { createInMemoryStorage, createLearnFrame } from "../../src/index.js";

function createResolver(videos: VideoMetadata[]): SourceResolver {
  return {
    async resolve(source: YoutubeSource) {
      return {
        courseId: "course-1",
        source,
        playlist: {
          id: "playlist-1",
          url: source.url,
          title: "Playlist",
          videos,
        },
        videos,
      };
    },
  };
}

function createTranscriptProvider(records: Record<string, Transcript>, calls: string[]): TranscriptProvider {
  return {
    async getTranscript(video) {
      calls.push(video.id);
      return records[video.id] ?? { videoId: video.id, status: "missing", segments: [] };
    },
  };
}

function createArtifactEngine(calls: Array<{ outputs: ArtifactKind[]; chunkVideoIds: string[] }>) {
  return {
    async generate(input: { courseId: string; chunks: Array<{ id: string; videoId: string }>; outputs: ArtifactKind[] }) {
      calls.push({ outputs: input.outputs, chunkVideoIds: [...new Set(input.chunks.map((chunk) => chunk.videoId))] });
      return input.outputs.map((kind) => {
        const videoId = input.chunks.length > 0 && (kind === "notes" || kind === "summary")
          ? input.chunks[0]?.videoId
          : undefined;
        return {
          id: `${input.courseId}:${kind}:${videoId ?? "course"}`,
          kind,
          courseId: input.courseId,
          videoId,
          promptVersion: `${kind}-v1`,
          cacheKey: `cache:${kind}:v1`,
          modelRole: "cheap",
          data: { kind, videoId: videoId ?? "course" },
        } satisfies Artifact;
      });
    },
  };
}

describe("sdk.process pipeline", () => {
  it("runs transcript, chunking, and artifact stages for one video", async () => {
    const storage = createInMemoryStorage();
    const transcriptCalls: string[] = [];
    const artifactCalls: Array<{ outputs: ArtifactKind[]; chunkVideoIds: string[] }> = [];
    const sdk = createLearnFrame({
      sourceResolver: createResolver([{ id: "v1", url: "https://youtube.com/watch?v=v1", availability: "available", position: 0 }]),
      storage,
      transcriptProvider: createTranscriptProvider({
        v1: {
          videoId: "v1",
          status: "available",
          provenance: { provider: "yt-dlp", language: "en", captionKind: "auto", sourceHash: "hash-v1", extractedAt: "2026-01-01T00:00:00.000Z" },
          segments: [{ id: "s1", videoId: "v1", startSeconds: 0, endSeconds: 3, text: "hello world" }],
        },
      }, transcriptCalls),
      artifactEngine: createArtifactEngine(artifactCalls),
    });

    const result = await sdk.process({
      source: { type: "video", url: "https://youtube.com/watch?v=v1" },
      outputs: ["transcript", "notes"],
    });

    expect(result.status).toBe("ready");
    expect(result.transcripts).toHaveLength(1);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["notes", "transcript"]);
    expect(transcriptCalls).toEqual(["v1"]);
    expect(artifactCalls).toEqual([{ outputs: ["notes"], chunkVideoIds: ["v1"] }]);
    expect(result.sync).toEqual({ added: ["v1"], updated: [], skipped: [] });
  });

  it("emits new progress stages through completion", async () => {
    const events: string[] = [];
    const sdk = createLearnFrame({
      sourceResolver: createResolver([{ id: "v1", url: "https://youtube.com/watch?v=v1", availability: "available", position: 0 }]),
      storage: createInMemoryStorage(),
      transcriptProvider: createTranscriptProvider({
        v1: {
          videoId: "v1",
          status: "available",
          segments: [{ id: "s1", videoId: "v1", startSeconds: 0, endSeconds: 1, text: "hello" }],
        },
      }, []),
      onProgress: async (event) => {
        events.push(`${event.stage}:${event.status}`);
      },
    });

    await sdk.process({ source: { type: "video", url: "https://youtube.com/watch?v=v1" }, outputs: [] });

    expect(events).toContain("validation:started");
    expect(events).toContain("source_resolution:completed");
    expect(events).toContain("transcript:completed");
    expect(events).toContain("chunking:completed");
    expect(events).toContain("artifact_generation:skipped");
    expect(events).toContain("qa_index:skipped");
    expect(events).toContain("completed:completed");
  });

  it("returns needs_transcription when transcript is unavailable", async () => {
    const sdk = createLearnFrame({
      sourceResolver: createResolver([{ id: "v1", url: "https://youtube.com/watch?v=v1", availability: "available", position: 0 }]),
      storage: createInMemoryStorage(),
      transcriptProvider: createTranscriptProvider({
        v1: { videoId: "v1", status: "missing", segments: [] },
      }, []),
    });

    const result = await sdk.process({ source: { type: "video", url: "https://youtube.com/watch?v=v1" }, outputs: ["notes"] });

    expect(result.status).toBe("needs_transcription");
    expect(result.chunks).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });

  it("reuses unchanged videos and processes only newly added videos", async () => {
    const storage = createInMemoryStorage();
    const transcriptCalls: string[] = [];
    const artifactCalls: Array<{ outputs: ArtifactKind[]; chunkVideoIds: string[] }> = [];
    const videosRound1 = [{ id: "v1", url: "https://youtube.com/watch?v=v1", availability: "available", position: 0 }] as VideoMetadata[];
    const videosRound2 = [
      { id: "v1", url: "https://youtube.com/watch?v=v1", availability: "available", position: 0 },
      { id: "v2", url: "https://youtube.com/watch?v=v2", availability: "available", position: 1 },
    ] as VideoMetadata[];
    let round = 1;

    const sdk = createLearnFrame({
      sourceResolver: {
        async resolve(source) {
          return {
            courseId: "course-1",
            source,
            playlist: {
              id: "playlist-1",
              url: source.url,
              videos: round === 1 ? videosRound1 : videosRound2,
            },
            videos: round === 1 ? videosRound1 : videosRound2,
          };
        },
      },
      storage,
      transcriptProvider: createTranscriptProvider({
        v1: { videoId: "v1", status: "available", segments: [{ id: "s1", videoId: "v1", startSeconds: 0, endSeconds: 2, text: "v1 text" }] },
        v2: { videoId: "v2", status: "available", segments: [{ id: "s1", videoId: "v2", startSeconds: 0, endSeconds: 2, text: "v2 text" }] },
      }, transcriptCalls),
      artifactEngine: createArtifactEngine(artifactCalls),
    });

    const first = await sdk.process({ source: { type: "playlist", url: "https://youtube.com/playlist?list=pl1" }, outputs: ["notes"] });
    round = 2;
    const second = await sdk.process({ source: { type: "playlist", url: "https://youtube.com/playlist?list=pl1" }, outputs: ["notes"] });

    expect(first.sync).toEqual({ added: ["v1"], updated: [], skipped: [] });
    expect(second.sync).toEqual({ added: ["v2"], updated: [], skipped: ["v1"] });
    expect(transcriptCalls).toEqual(["v1", "v2"]);
    expect(second.artifacts.filter((artifact) => artifact.kind === "notes").map((artifact) => artifact.videoId).sort()).toEqual(["v1", "v2"]);
    expect(artifactCalls).toHaveLength(2);
  });

  it("keeps unchanged video artifacts across incremental runs", async () => {
    const storage = createInMemoryStorage();
    let playlistVideos: VideoMetadata[] = [
      { id: "v1", url: "https://youtube.com/watch?v=v1", availability: "available", position: 0 },
    ];
    const sdk = createLearnFrame({
      sourceResolver: {
        async resolve(source) {
          return {
            courseId: "course-1",
            source,
            playlist: { id: "playlist-1", url: source.url, videos: playlistVideos },
            videos: playlistVideos,
          };
        },
      },
      storage,
      transcriptProvider: createTranscriptProvider({
        v1: { videoId: "v1", status: "available", segments: [{ id: "s1", videoId: "v1", startSeconds: 0, endSeconds: 2, text: "v1" }] },
        v2: { videoId: "v2", status: "available", segments: [{ id: "s1", videoId: "v2", startSeconds: 0, endSeconds: 2, text: "v2" }] },
      }, []),
      artifactEngine: createArtifactEngine([]),
    });

    const first = await sdk.process({ source: { type: "playlist", url: "https://youtube.com/playlist?list=pl1" }, outputs: ["notes"] });
    const firstV1Note = first.artifacts.find((artifact) => artifact.kind === "notes" && artifact.videoId === "v1");

    playlistVideos = [
      { id: "v1", url: "https://youtube.com/watch?v=v1", availability: "available", position: 0 },
      { id: "v2", url: "https://youtube.com/watch?v=v2", availability: "available", position: 1 },
    ];

    const second = await sdk.process({ source: { type: "playlist", url: "https://youtube.com/playlist?list=pl1" }, outputs: ["notes"] });
    const secondV1Note = second.artifacts.find((artifact) => artifact.kind === "notes" && artifact.videoId === "v1");

    expect(firstV1Note).toBeDefined();
    expect(secondV1Note).toEqual(firstV1Note);
  });

  it("exports deterministic JSON and Markdown with provenance and cache metadata", async () => {
    const storage = createInMemoryStorage();
    const sdk = createLearnFrame({
      sourceResolver: createResolver([{ id: "v1", url: "https://youtube.com/watch?v=v1", availability: "available", position: 0 }]),
      storage,
      transcriptProvider: createTranscriptProvider({
        v1: {
          videoId: "v1",
          status: "available",
          provenance: { provider: "yt-dlp", language: "en", captionKind: "auto", sourceHash: "source-hash", extractedAt: "2026-01-01T00:00:00.000Z" },
          segments: [{ id: "s1", videoId: "v1", startSeconds: 0, endSeconds: 2, text: "hello" }],
        },
      }, []),
      artifactEngine: createArtifactEngine([]),
    });

    const processResult = await sdk.process({ source: { type: "video", url: "https://youtube.com/watch?v=v1" }, outputs: ["transcript", "notes"] });
    const exported = await sdk.exportPack({ courseId: processResult.courseId });

    expect(exported.manifest.videoCount).toBe(1);
    expect(exported.manifest.artifactCount).toBeGreaterThanOrEqual(2);
    expect(exported.json).toContain("\"promptVersion\": \"notes-v1\"");
    expect(exported.json).toContain("\"cacheKey\": \"cache:notes:v1\"");
    expect(exported.json).toContain("\"provider\": \"yt-dlp\"");
    expect(exported.markdown).toContain("## Artifacts");
    expect(exported.markdown).toContain("Prompt version: notes-v1");
  });
});
