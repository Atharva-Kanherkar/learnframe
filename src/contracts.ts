export type YoutubeSourceType = "video" | "playlist";

export type YoutubeVideoSource = {
  type: "video";
  url: string;
  videoId?: string;
  language?: string;
};

export type YoutubePlaylistSource = {
  type: "playlist";
  url: string;
  playlistId?: string;
  language?: string;
};

export type YoutubeSource = YoutubeVideoSource | YoutubePlaylistSource;

export type VideoAvailability = "available" | "private" | "deleted" | "unavailable";

export type VideoMetadata = {
  id: string;
  url: string;
  title?: string;
  description?: string;
  durationSeconds?: number;
  channelId?: string;
  channelTitle?: string;
  publishedAt?: string;
  position?: number;
  availability: VideoAvailability;
  etag?: string;
};

export type PlaylistMetadata = {
  id: string;
  url: string;
  title?: string;
  description?: string;
  videos: VideoMetadata[];
};

export type SourceResolutionMetadata = {
  provider: string;
  cacheKey?: string;
  cacheHit?: boolean;
  cachedAt?: string;
  expiresAt?: string;
  pageCount?: number;
  truncated?: boolean;
  nextPageToken?: string;
  duplicateCount?: number;
  unavailableCount?: number;
};

export type ResolvedYoutubeSource = {
  courseId: string;
  source: YoutubeSource;
  playlist: PlaylistMetadata;
  videos: VideoMetadata[];
  sourceResolution?: SourceResolutionMetadata;
};

export type TranscriptStatus = "available" | "missing" | "blocked" | "needs_transcription";

export type CaptionKind = "human" | "auto" | "transcribed";

export type TranscriptProvenance = {
  provider: string;
  language: string;
  captionKind: CaptionKind;
  sourceHash: string;
  extractedAt: string;
};

export type TranscriptSegment = {
  id: string;
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence?: number;
};

export type Transcript = {
  videoId: string;
  status: TranscriptStatus;
  provenance?: TranscriptProvenance;
  segments: TranscriptSegment[];
};

export type TranscriptChunk = {
  id: string;
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  sourceSegmentIds: string[];
  tokenEstimate: number;
};

export type ArtifactKind =
  | "transcript"
  | "summary"
  | "notes"
  | "syllabus"
  | "qa"
  | "glossary"
  | "quiz"
  | "flashcards"
  | "study_plan"
  | "prerequisite_map";

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  courseId: string;
  videoId?: string;
  promptVersion?: string;
  modelRole?: "cheap" | "medium" | "strong";
  cacheKey?: string;
  data: unknown;
};

export type ProgressStage =
  | "validation"
  | "source_resolution"
  | "transcript"
  | "chunking"
  | "artifact_generation"
  | "qa_index"
  | "completed";

export type ProgressStatus = "started" | "completed" | "failed" | "skipped";

export type ProgressEvent = {
  stage: ProgressStage;
  status: ProgressStatus;
  message?: string;
  timestamp: string;
  data?: Record<string, unknown>;
};

export type ProcessInput = {
  source: YoutubeSource;
  outputs?: ArtifactKind[];
  transcript?: TranscriptRequest;
  incremental?: {
    enabled?: boolean;
  };
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
};

export type ProcessSyncSummary = {
  added: string[];
  updated: string[];
  skipped: string[];
};

export type ProcessResult = {
  courseId: string;
  source: YoutubeSource;
  playlist: PlaylistMetadata;
  videos: VideoMetadata[];
  transcripts: Transcript[];
  chunks: TranscriptChunk[];
  artifacts: Artifact[];
  status: "ready" | "partial" | "needs_transcription";
  sync: ProcessSyncSummary;
  sourceResolution?: SourceResolutionMetadata;
  createdAt: string;
};

export type ProcessedVideoState = {
  video: VideoMetadata;
  fingerprint: string;
  transcript: Transcript;
  chunks: TranscriptChunk[];
  artifacts: Artifact[];
};

export type CourseProcessingState = {
  courseId: string;
  source: YoutubeSource;
  playlist: PlaylistMetadata;
  videos: VideoMetadata[];
  transcripts: Transcript[];
  chunks: TranscriptChunk[];
  artifacts: Artifact[];
  processedVideos: Record<string, ProcessedVideoState>;
  sourceResolution?: SourceResolutionMetadata;
  chunkEmbeddings?: Record<string, number[]>;
  sync: ProcessSyncSummary;
  createdAt: string;
  updatedAt: string;
};

export type ExportPackInput = {
  courseId: string;
};

export type ExportPackManifest = {
  courseId: string;
  generatedAt: string;
  videoCount: number;
  transcriptCount: number;
  chunkCount: number;
  artifactCount: number;
};

export type ExportPackResult = {
  courseId: string;
  generatedAt: string;
  json: string;
  markdown: string;
  manifest: ExportPackManifest;
};

export type TimestampRange = {
  videoId: string;
  startSeconds: number;
  endSeconds: number;
};

export type AskAtTimestampInput = {
  courseId: string;
  videoId?: string;
  timestampSeconds?: number;
  selectedText?: string;
  question: string;
};

export type AnswerCitation = TimestampRange & {
  chunkId?: string;
  text?: string;
};

export type AskResponse = {
  answer: string;
  status: "answered" | "insufficient_context";
  citations: AnswerCitation[];
  replayRanges: TimestampRange[];
  followUpQuestions: string[];
  confidence: {
    score: number;
    reason: string;
  };
};

export type RetrievalQaEngine = {
  ask(input: AskAtTimestampInput): Promise<AskResponse>;
};

export type SourceResolver = {
  resolve(source: YoutubeSource, context: AdapterContext): Promise<ResolvedYoutubeSource>;
};

export type TranscriptProvider = {
  getTranscript(video: VideoMetadata, options: TranscriptRequest): Promise<Transcript>;
};

export type TranscriptRequest = {
  language?: string;
  allowPaidTranscription?: boolean;
  fallbackLanguages?: string[];
  allowAutoCaptions?: boolean;
  preferHumanCaptions?: boolean;
};

export type LlmRequest = {
  task: string;
  promptVersion: string;
  input: unknown;
  modelRole?: "cheap" | "medium" | "strong";
};

export type LlmAdapter = {
  generateStructured<T>(request: LlmRequest): Promise<T>;
};

export type EmbeddingsAdapter = {
  embed(texts: string[]): Promise<number[][]>;
};

export type StorageAdapter = {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
};

export type Logger = {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
  error?(message: string, data?: Record<string, unknown>): void;
};

export type AdapterContext = {
  storage: StorageAdapter;
  logger?: Logger;
  reportProgress(event: Omit<ProgressEvent, "timestamp">): Promise<void>;
};

export type LearnFrameSdkOptions = {
  sourceResolver: SourceResolver;
  storage: StorageAdapter;
  transcriptProvider?: TranscriptProvider;
  artifactEngine?: {
    generate(input: {
      courseId: string;
      chunks: TranscriptChunk[];
      outputs: ArtifactKind[];
    }): Promise<Artifact[]>;
  };
  llm?: LlmAdapter;
  embeddings?: EmbeddingsAdapter;
  qa?: RetrievalQaEngine;
  logger?: Logger;
  courseStateKeyPrefix?: string;
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
};

export type LearnFrameSdk = {
  process(input: ProcessInput): Promise<ProcessResult>;
  ask(input: AskAtTimestampInput): Promise<AskResponse>;
  exportPack(input: ExportPackInput): Promise<ExportPackResult>;
};

export type PlayerState = {
  videoId: string;
  currentTimeSeconds: number;
  isPlaying: boolean;
  durationSeconds?: number;
};

export type SeekTarget = {
  videoId: string;
  timestampSeconds: number;
};

export type PlayerStateAdapter = {
  getState(): PlayerState;
  seek(target: SeekTarget): void;
  subscribe(callback: (state: PlayerState) => void): () => void;
};

export type LearnFrameErrorCode =
  | "INVALID_SOURCE"
  | "INVALID_ASK_INPUT"
  | "INVALID_EXPORT_INPUT"
  | "RESOLUTION_FAILED"
  | "TRANSCRIPT_PROVIDER_MISSING"
  | "TRANSCRIPT_FAILED"
  | "ARTIFACT_ENGINE_MISSING"
  | "ARTIFACT_GENERATION_FAILED"
  | "COURSE_NOT_FOUND"
  | "EXPORT_FAILED";

export class LearnFrameError extends Error {
  readonly code: LearnFrameErrorCode;
  readonly cause?: unknown;

  constructor(code: LearnFrameErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "LearnFrameError";
    this.code = code;
    this.cause = cause;
  }
}
