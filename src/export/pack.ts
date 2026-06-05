import type {
  Artifact,
  CourseProcessingState,
  ExportPackManifest,
  ExportPackResult,
  Transcript,
  TranscriptChunk,
  VideoMetadata,
} from "../contracts.js";

type CourseExportPayload = {
  manifest: ExportPackManifest;
  source: CourseProcessingState["source"];
  playlist: CourseProcessingState["playlist"];
  videos: VideoMetadata[];
  sourceResolution?: CourseProcessingState["sourceResolution"];
  sync: CourseProcessingState["sync"];
  transcripts: Array<{
    videoId: string;
    status: Transcript["status"];
    segmentCount: number;
    provenance?: Transcript["provenance"];
  }>;
  chunks: TranscriptChunk[];
  artifacts: Artifact[];
};

export function buildExportPackResult(state: CourseProcessingState, generatedAt = new Date().toISOString()): ExportPackResult {
  const videos = sortVideos(state.videos);
  const transcripts = sortTranscripts(state.transcripts, videos);
  const chunks = sortChunks(state.chunks, videos);
  const artifacts = sortArtifacts(state.artifacts);
  const manifest: ExportPackManifest = {
    courseId: state.courseId,
    generatedAt,
    videoCount: videos.length,
    transcriptCount: transcripts.length,
    chunkCount: chunks.length,
    artifactCount: artifacts.length,
  };

  const payload: CourseExportPayload = {
    manifest,
    source: state.source,
    playlist: state.playlist,
    videos,
    sourceResolution: state.sourceResolution,
    sync: state.sync,
    transcripts: transcripts.map((transcript) => ({
      videoId: transcript.videoId,
      status: transcript.status,
      segmentCount: transcript.segments.length,
      provenance: transcript.provenance,
    })),
    chunks,
    artifacts,
  };

  return {
    courseId: state.courseId,
    generatedAt,
    json: JSON.stringify(sortKeysDeep(payload), null, 2),
    markdown: renderMarkdown(payload),
    manifest,
  };
}

function renderMarkdown(payload: CourseExportPayload): string {
  const lines: string[] = [];
  lines.push(`# LearnFrame Export: ${payload.manifest.courseId}`);
  lines.push("");
  lines.push(`- Generated: ${payload.manifest.generatedAt}`);
  lines.push(`- Videos: ${payload.manifest.videoCount}`);
  lines.push(`- Transcripts: ${payload.manifest.transcriptCount}`);
  lines.push(`- Chunks: ${payload.manifest.chunkCount}`);
  lines.push(`- Artifacts: ${payload.manifest.artifactCount}`);
  lines.push("");

  lines.push("## Sync Summary");
  lines.push("");
  lines.push(`- Added: ${payload.sync.added.length ? payload.sync.added.join(", ") : "none"}`);
  lines.push(`- Updated: ${payload.sync.updated.length ? payload.sync.updated.join(", ") : "none"}`);
  lines.push(`- Skipped: ${payload.sync.skipped.length ? payload.sync.skipped.join(", ") : "none"}`);
  lines.push("");

  lines.push("## Videos");
  lines.push("");
  for (const video of payload.videos) {
    lines.push(`- ${video.id}: ${video.title ?? "untitled"} (${video.availability})`);
  }
  lines.push("");

  lines.push("## Transcripts");
  lines.push("");
  for (const transcript of payload.transcripts) {
    const provenance = transcript.provenance
      ? `${transcript.provenance.provider}/${transcript.provenance.language}/${transcript.provenance.captionKind}`
      : "none";
    lines.push(`- ${transcript.videoId}: ${transcript.status}, ${transcript.segmentCount} segments, provenance ${provenance}`);
  }
  lines.push("");

  lines.push("## Artifacts");
  lines.push("");
  if (payload.artifacts.length === 0) {
    lines.push("No artifacts generated.");
    return lines.join("\n");
  }

  for (const artifact of payload.artifacts) {
    lines.push(`### ${artifact.kind} (${artifact.id})`);
    lines.push("");
    lines.push(`- Video: ${artifact.videoId ?? "course"}`);
    lines.push(`- Model role: ${artifact.modelRole ?? "unknown"}`);
    lines.push(`- Prompt version: ${artifact.promptVersion ?? "unknown"}`);
    lines.push(`- Cache key: ${artifact.cacheKey ?? "none"}`);
    lines.push("- Data:");
    lines.push("```json");
    lines.push(JSON.stringify(sortKeysDeep(artifact.data), null, 2));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function sortVideos(videos: VideoMetadata[]): VideoMetadata[] {
  return [...videos].sort((left, right) => {
    const positionDiff = (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER);
    if (positionDiff !== 0) {
      return positionDiff;
    }
    return left.id.localeCompare(right.id);
  });
}

function sortTranscripts(transcripts: Transcript[], videos: VideoMetadata[]): Transcript[] {
  const order = new Map(videos.map((video, index) => [video.id, index]));
  return [...transcripts].sort((left, right) => {
    const leftOrder = order.get(left.videoId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.videoId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.videoId.localeCompare(right.videoId);
  });
}

function sortChunks(chunks: TranscriptChunk[], videos: VideoMetadata[]): TranscriptChunk[] {
  const order = new Map(videos.map((video, index) => [video.id, index]));
  return [...chunks].sort((left, right) => {
    const leftOrder = order.get(left.videoId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.videoId) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.startSeconds - right.startSeconds || left.id.localeCompare(right.id);
  });
}

function sortArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...artifacts]
    .map((artifact) => ({ ...artifact, data: sortKeysDeep(artifact.data) }))
    .sort((left, right) => {
      return left.kind.localeCompare(right.kind)
        || (left.videoId ?? "").localeCompare(right.videoId ?? "")
        || left.id.localeCompare(right.id);
    });
}

function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeysDeep(entry)) as T;
  }
  if (value && typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortKeysDeep(entryValue)]);
    return Object.fromEntries(sortedEntries) as T;
  }
  return value;
}
