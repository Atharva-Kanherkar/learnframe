import type { Artifact, ArtifactKind, LlmAdapter, LlmRequest, StorageAdapter, TranscriptChunk } from "../contracts.js";
import { createArtifactCacheKey, createInputHash } from "../cache/keys.js";
import { getOrComputeCached } from "../cache/resumable.js";
import {
  chunkNotesSchema,
  flashcardsSchema,
  glossarySchema,
  playlistSyllabusSchema,
  prerequisiteMapSchema,
  quizSchema,
  studyPlanSchema,
  videoSummarySchema,
  type ChunkNotesPayload,
  type VideoSummaryPayload,
} from "./schemas.js";

export type LowCostArtifactEngineOptions = {
  llm: LlmAdapter;
  storage: StorageAdapter;
  models?: Partial<Record<"cheap" | "medium" | "strong", string>>;
};

export type GenerateArtifactsInput = {
  courseId: string;
  chunks: TranscriptChunk[];
  outputs: ArtifactKind[];
};

export type LowCostArtifactEngine = {
  generate(input: GenerateArtifactsInput): Promise<Artifact[]>;
};

type ArtifactTask<T> = {
  artifactKind: ArtifactKind;
  task: string;
  promptVersion: string;
  modelRole: "cheap" | "medium" | "strong";
  input: unknown;
  parse(output: unknown): T;
  artifactVideoId?: string;
};

const DEFAULT_MODELS = {
  cheap: "cheap",
  medium: "medium",
  strong: "strong",
};

export function createLowCostArtifactEngine(options: LowCostArtifactEngineOptions): LowCostArtifactEngine {
  const models = { ...DEFAULT_MODELS, ...options.models };

  async function runTask<T>(courseId: string, task: ArtifactTask<T>): Promise<Artifact> {
    const model = models[task.modelRole];
    const inputHash = createInputHash(task.input);
    const cacheKey = createArtifactCacheKey({
      task: task.task,
      model,
      promptVersion: task.promptVersion,
      inputHash,
      options: { artifactKind: task.artifactKind },
    });
    const { value } = await getOrComputeCached(options.storage, cacheKey, async () => {
      const request: LlmRequest = {
        task: task.task,
        promptVersion: task.promptVersion,
        modelRole: task.modelRole,
        input: task.input,
      };
      return task.parse(await options.llm.generateStructured(request));
    });

    return {
      id: `${courseId}:${task.artifactKind}:${inputHash}`,
      kind: task.artifactKind,
      courseId,
      videoId: task.artifactVideoId,
      promptVersion: task.promptVersion,
      modelRole: task.modelRole,
      cacheKey,
      data: value,
    };
  }

  return {
    async generate(input) {
      const requested = new Set(input.outputs);
      const artifacts: Artifact[] = [];
      const needsChunkNotes = requested.has("notes") || requested.has("summary") || requested.has("syllabus") || requested.has("glossary") || requested.has("quiz") || requested.has("flashcards") || requested.has("study_plan") || requested.has("prerequisite_map");
      const noteArtifacts = needsChunkNotes ? await Promise.all(input.chunks.map((chunk) => runTask(input.courseId, createChunkNotesTask(chunk)))) : [];

      if (requested.has("notes")) {
        artifacts.push(...noteArtifacts);
      }

      const chunkNotes = noteArtifacts.map((artifact) => artifact.data as ChunkNotesPayload);
      const needsVideoSummaries = requested.has("summary") || requested.has("syllabus") || requested.has("study_plan") || requested.has("prerequisite_map");
      const summaryArtifacts = needsVideoSummaries
        ? await Promise.all([...groupNotesByVideo(chunkNotes).entries()].map(([videoId, notes]) => runTask(input.courseId, createVideoSummaryTask(videoId, notes))))
        : [];

      if (requested.has("summary")) {
        artifacts.push(...summaryArtifacts);
      }

      const videoSummaries = summaryArtifacts.map((artifact) => artifact.data as VideoSummaryPayload);
      const aggregateTasks: Array<ArtifactTask<unknown>> = [];
      if (requested.has("syllabus")) {
        aggregateTasks.push(createPlaylistSyllabusTask(input.courseId, videoSummaries));
      }
      if (requested.has("glossary")) {
        aggregateTasks.push(createGlossaryTask(chunkNotes));
      }
      if (requested.has("quiz")) {
        aggregateTasks.push(createQuizTask(chunkNotes));
      }
      if (requested.has("flashcards")) {
        aggregateTasks.push(createFlashcardsTask(chunkNotes));
      }
      if (requested.has("study_plan")) {
        aggregateTasks.push(createStudyPlanTask(input.courseId, videoSummaries));
      }
      if (requested.has("prerequisite_map")) {
        aggregateTasks.push(createPrerequisiteMapTask(chunkNotes, videoSummaries));
      }

      artifacts.push(...(await Promise.all(aggregateTasks.map((task) => runTask(input.courseId, task)))));
      return artifacts;
    },
  };
}

function createChunkNotesTask(chunk: TranscriptChunk): ArtifactTask<ChunkNotesPayload> {
  return {
    artifactKind: "notes",
    task: "chunk-notes",
    promptVersion: "chunk-notes-v1",
    modelRole: "cheap",
    artifactVideoId: chunk.videoId,
    input: {
      chunkId: chunk.id,
      videoId: chunk.videoId,
      text: chunk.text,
      citations: [{ videoId: chunk.videoId, startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds, chunkId: chunk.id }],
    },
    parse: (output) => chunkNotesSchema.parse(output),
  };
}

function createVideoSummaryTask(videoId: string, notes: ChunkNotesPayload[]): ArtifactTask<VideoSummaryPayload> {
  return {
    artifactKind: "summary",
    task: "video-summary",
    promptVersion: "video-summary-v1",
    modelRole: "medium",
    artifactVideoId: videoId,
    input: { videoId, chunkNotes: notes },
    parse: (output) => videoSummarySchema.parse(output),
  };
}

function createPlaylistSyllabusTask(courseId: string, videoSummaries: VideoSummaryPayload[]): ArtifactTask<unknown> {
  return {
    artifactKind: "syllabus",
    task: "playlist-syllabus",
    promptVersion: "playlist-syllabus-v1",
    modelRole: "medium",
    input: { courseId, videoSummaries },
    parse: (output) => playlistSyllabusSchema.parse(output),
  };
}

function createGlossaryTask(chunkNotes: ChunkNotesPayload[]): ArtifactTask<unknown> {
  return { artifactKind: "glossary", task: "glossary", promptVersion: "glossary-v1", modelRole: "cheap", input: { chunkNotes }, parse: (output) => glossarySchema.parse(output) };
}

function createQuizTask(chunkNotes: ChunkNotesPayload[]): ArtifactTask<unknown> {
  return { artifactKind: "quiz", task: "quiz", promptVersion: "quiz-v1", modelRole: "cheap", input: { chunkNotes }, parse: (output) => quizSchema.parse(output) };
}

function createFlashcardsTask(chunkNotes: ChunkNotesPayload[]): ArtifactTask<unknown> {
  return { artifactKind: "flashcards", task: "flashcards", promptVersion: "flashcards-v1", modelRole: "cheap", input: { chunkNotes }, parse: (output) => flashcardsSchema.parse(output) };
}

function createStudyPlanTask(courseId: string, videoSummaries: VideoSummaryPayload[]): ArtifactTask<unknown> {
  return { artifactKind: "study_plan", task: "study-plan", promptVersion: "study-plan-v1", modelRole: "medium", input: { courseId, videoSummaries }, parse: (output) => studyPlanSchema.parse(output) };
}

function createPrerequisiteMapTask(chunkNotes: ChunkNotesPayload[], videoSummaries: VideoSummaryPayload[]): ArtifactTask<unknown> {
  return { artifactKind: "prerequisite_map", task: "prerequisite-map", promptVersion: "prerequisite-map-v1", modelRole: "medium", input: { chunkNotes, videoSummaries }, parse: (output) => prerequisiteMapSchema.parse(output) };
}

function groupNotesByVideo(notes: ChunkNotesPayload[]): Map<string, ChunkNotesPayload[]> {
  const grouped = new Map<string, ChunkNotesPayload[]>();
  for (const note of notes) {
    grouped.set(note.videoId, [...(grouped.get(note.videoId) ?? []), note]);
  }
  return grouped;
}
