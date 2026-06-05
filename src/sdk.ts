import { createHash } from "node:crypto";
import type {
  AdapterContext,
  Artifact,
  ArtifactKind,
  AskAtTimestampInput,
  AskResponse,
  CourseProcessingState,
  LearnFrameSdk,
  LearnFrameSdkOptions,
  ProcessInput,
  ProcessResult,
  ProcessSyncSummary,
  ProgressEvent,
  ProgressStage,
  ProgressStatus,
  Transcript,
  TranscriptChunk,
  VideoMetadata,
} from "./contracts.js";
import { LearnFrameError } from "./contracts.js";
import { createLowCostArtifactEngine } from "./artifacts/engine.js";
import { chunkTranscript } from "./chunking/chunker.js";
import { buildExportPackResult } from "./export/pack.js";
import { askAtTimestampInputSchema, exportPackInputSchema, sourceSchema } from "./schemas.js";
import { stableStringify } from "./source/keys.js";

const DEFAULT_STATE_KEY_PREFIX = "course-state:v1";
const PER_VIDEO_ARTIFACT_KINDS = new Set<ArtifactKind>(["notes", "summary"]);

export function createYoutubeLearningSdk(options: LearnFrameSdkOptions): LearnFrameSdk {
  async function emit(
    input: ProcessInput | undefined,
    stage: ProgressStage,
    status: ProgressStatus,
    message?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const event: ProgressEvent = {
      stage,
      status,
      message,
      data,
      timestamp: new Date().toISOString(),
    };

    await options.onProgress?.(event);
    await input?.onProgress?.(event);
  }

  function createContext(input?: ProcessInput): AdapterContext {
    return {
      storage: options.storage,
      logger: options.logger,
      reportProgress: async (event) => {
        await emit(input, event.stage, event.status, event.message, event.data);
      },
    };
  }

  return {
    async process(input) {
      await emit(input, "validation", "started", "Validating source input");

      const sourceResult = sourceSchema.safeParse(input.source);
      if (!sourceResult.success) {
        await emit(input, "validation", "failed", "Invalid source input");
        throw new LearnFrameError("INVALID_SOURCE", "Invalid YouTube source input", sourceResult.error);
      }

      await emit(input, "validation", "completed", "Source input is valid");
      await emit(input, "source_resolution", "started", "Resolving YouTube source");

      let resolved: Awaited<ReturnType<LearnFrameSdkOptions["sourceResolver"]["resolve"]>>;
      try {
        resolved = await options.sourceResolver.resolve(sourceResult.data, createContext(input));
        await emit(input, "source_resolution", "completed", "YouTube source resolved", {
          courseId: resolved.courseId,
          videoCount: resolved.videos.length,
        });
      } catch (error) {
        await emit(input, "source_resolution", "failed", "YouTube source resolution failed");
        if (error instanceof LearnFrameError) {
          throw error;
        }
        throw new LearnFrameError("RESOLUTION_FAILED", "YouTube source resolution failed", error);
      }

      const now = new Date().toISOString();
      const incrementalEnabled = input.incremental?.enabled ?? true;
      const outputs = normalizeOutputs(input.outputs);
      const stateKey = courseStateKey(resolved.courseId, options.courseStateKeyPrefix);
      const previousState = incrementalEnabled
        ? await options.storage.get<CourseProcessingState>(stateKey)
        : undefined;
      const previousByVideo = previousState?.processedVideos ?? {};

      const sync: ProcessSyncSummary = { added: [], updated: [], skipped: [] };
      const fingerprints = new Map<string, string>();
      const changedVideos: VideoMetadata[] = [];
      const unchangedVideoIds = new Set<string>();
      const transcriptByVideo = new Map<string, Transcript>();
      const chunksByVideo = new Map<string, TranscriptChunk[]>();
      const storedArtifactsByVideo = new Map<string, Artifact[]>();

      for (const video of resolved.videos) {
        const fingerprint = createVideoFingerprint(video);
        fingerprints.set(video.id, fingerprint);

        const previousVideoState = previousByVideo[video.id];
        if (
          incrementalEnabled
          && previousVideoState
          && previousVideoState.fingerprint === fingerprint
          && isTranscriptUsable(previousVideoState.transcript)
          && previousVideoState.chunks.length > 0
        ) {
          sync.skipped.push(video.id);
          unchangedVideoIds.add(video.id);
          transcriptByVideo.set(video.id, previousVideoState.transcript);
          chunksByVideo.set(video.id, previousVideoState.chunks);
          storedArtifactsByVideo.set(video.id, previousVideoState.artifacts);
          continue;
        }

        if (previousVideoState) {
          sync.updated.push(video.id);
        } else {
          sync.added.push(video.id);
        }

        changedVideos.push(video);
        storedArtifactsByVideo.set(video.id, []);
      }

      const transcriptRequest = {
        language: input.transcript?.language ?? sourceResult.data.language,
        allowPaidTranscription: input.transcript?.allowPaidTranscription ?? false,
        fallbackLanguages: input.transcript?.fallbackLanguages,
        allowAutoCaptions: input.transcript?.allowAutoCaptions,
        preferHumanCaptions: input.transcript?.preferHumanCaptions,
      };

      if (changedVideos.length === 0) {
        await emit(input, "transcript", "skipped", "No new or updated videos. Reusing cached transcripts", {
          skippedVideoCount: sync.skipped.length,
        });
      } else {
        await emit(input, "transcript", "started", "Extracting or transcribing video transcripts", {
          changedVideoCount: changedVideos.length,
          skippedVideoCount: sync.skipped.length,
        });

        for (const video of changedVideos) {
          if (!options.transcriptProvider) {
            transcriptByVideo.set(
              video.id,
              createEmptyTranscript(
                video.id,
                transcriptRequest.allowPaidTranscription ? "needs_transcription" : "missing",
              ),
            );
            continue;
          }

          try {
            transcriptByVideo.set(video.id, await options.transcriptProvider.getTranscript(video, transcriptRequest));
          } catch (error) {
            await emit(input, "transcript", "failed", "Transcript extraction failed", { videoId: video.id });
            if (error instanceof LearnFrameError) {
              throw error;
            }
            throw new LearnFrameError("TRANSCRIPT_FAILED", `Transcript extraction failed for ${video.id}`, error);
          }
        }

        const availableTranscriptCount = changedVideos.filter((video) => isTranscriptUsable(transcriptByVideo.get(video.id))).length;
        await emit(input, "transcript", "completed", "Transcript stage completed", {
          changedVideoCount: changedVideos.length,
          availableTranscriptCount,
        });
      }

      const transcriptsToChunk = changedVideos
        .map((video) => transcriptByVideo.get(video.id))
        .filter((transcript): transcript is Transcript => isTranscriptUsable(transcript));

      if (transcriptsToChunk.length === 0) {
        await emit(input, "chunking", "skipped", "No transcripts available for chunking");
      } else {
        await emit(input, "chunking", "started", "Chunking transcript segments", {
          transcriptCount: transcriptsToChunk.length,
        });

        for (const transcript of transcriptsToChunk) {
          chunksByVideo.set(transcript.videoId, chunkTranscript(transcript));
        }

        await emit(input, "chunking", "completed", "Chunking completed", {
          chunkCount: transcriptsToChunk.reduce((total, transcript) => total + (chunksByVideo.get(transcript.videoId)?.length ?? 0), 0),
        });
      }

      const transcripts = resolved.videos.map((video) => transcriptByVideo.get(video.id) ?? createEmptyTranscript(video.id));
      const allChunks = flattenChunksByVideo(resolved.videos, chunksByVideo);

      if (outputs.includes("transcript")) {
        for (const transcript of transcripts) {
          const currentArtifacts = storedArtifactsByVideo.get(transcript.videoId) ?? [];
          storedArtifactsByVideo.set(
            transcript.videoId,
            mergeArtifacts(currentArtifacts, [createTranscriptArtifact(resolved.courseId, transcript)], ["transcript"]),
          );
        }
      }

      const requestedArtifactOutputs = outputs.filter((kind) => kind !== "transcript");
      const perVideoOutputs = requestedArtifactOutputs.filter((kind) => PER_VIDEO_ARTIFACT_KINDS.has(kind));
      const aggregateOutputs = requestedArtifactOutputs.filter((kind) => !PER_VIDEO_ARTIFACT_KINDS.has(kind));

      let storedAggregateArtifacts = previousState?.artifacts.filter((artifact) => !artifact.videoId && artifact.kind !== "transcript") ?? [];
      if (sync.added.length > 0 || sync.updated.length > 0) {
        storedAggregateArtifacts = [];
      }

      if (requestedArtifactOutputs.length === 0) {
        await emit(input, "artifact_generation", "skipped", "No artifact outputs requested");
      } else {
        const perVideoWork = new Map<string, ArtifactKind[]>();
        for (const video of resolved.videos) {
          const transcript = transcripts.find((entry) => entry.videoId === video.id);
          const videoChunks = chunksByVideo.get(video.id) ?? [];
          if (!isTranscriptUsable(transcript) || videoChunks.length === 0) {
            continue;
          }

          const existingKinds = new Set((storedArtifactsByVideo.get(video.id) ?? []).map((artifact) => artifact.kind));
          const missingKinds = perVideoOutputs.filter((kind) => !existingKinds.has(kind));
          if (!unchangedVideoIds.has(video.id)) {
            perVideoWork.set(video.id, perVideoOutputs);
          } else if (missingKinds.length > 0) {
            perVideoWork.set(video.id, missingKinds);
          }
        }

        const missingAggregateKinds = aggregateOutputs.filter(
          (kind) => !storedAggregateArtifacts.some((artifact) => artifact.kind === kind),
        );
        const regenerateAggregate = (sync.added.length > 0 || sync.updated.length > 0 || missingAggregateKinds.length > 0)
          && aggregateOutputs.length > 0;

        const needsGeneration = perVideoWork.size > 0 || regenerateAggregate;
        const needsLlm = needsGeneration;

        if (needsLlm && !options.artifactEngine && !options.llm) {
          throw new LearnFrameError(
            "ARTIFACT_ENGINE_MISSING",
            "Artifact generation requested but no artifact engine or LLM adapter was configured",
          );
        }

        const artifactEngine = needsGeneration
          ? options.artifactEngine
            ?? createLowCostArtifactEngine({ llm: options.llm!, storage: options.storage })
          : undefined;

        await emit(input, "artifact_generation", "started", "Generating or reusing artifacts", {
          changedVideos: changedVideos.length,
          skippedVideos: sync.skipped.length,
          requestedArtifactOutputs,
        });

        try {
          if (artifactEngine) {
            for (const [videoId, videoOutputs] of perVideoWork.entries()) {
              const videoChunks = chunksByVideo.get(videoId) ?? [];
              if (videoChunks.length === 0 || videoOutputs.length === 0) {
                continue;
              }
              const generated = await artifactEngine.generate({
                courseId: resolved.courseId,
                chunks: videoChunks,
                outputs: videoOutputs,
              });
              const currentArtifacts = storedArtifactsByVideo.get(videoId) ?? [];
              storedArtifactsByVideo.set(videoId, mergeArtifacts(currentArtifacts, generated, videoOutputs));
            }

            if (regenerateAggregate && aggregateOutputs.length > 0 && allChunks.length > 0) {
              const generatedAggregateArtifacts = await artifactEngine.generate({
                courseId: resolved.courseId,
                chunks: allChunks,
                outputs: aggregateOutputs,
              });
              storedAggregateArtifacts = mergeArtifacts(storedAggregateArtifacts, generatedAggregateArtifacts, aggregateOutputs);
            }
          }

          await emit(input, "artifact_generation", "completed", "Artifact stage completed", {
            perVideoGeneratedCount: perVideoWork.size,
            aggregateGeneratedCount: regenerateAggregate ? aggregateOutputs.length : 0,
          });
        } catch (error) {
          await emit(input, "artifact_generation", "failed", "Artifact generation failed");
          if (error instanceof LearnFrameError) {
            throw error;
          }
          throw new LearnFrameError("ARTIFACT_GENERATION_FAILED", "Artifact generation failed", error);
        }
      }

      let chunkEmbeddings: Record<string, number[]> | undefined;
      if (!options.embeddings || allChunks.length === 0) {
        await emit(input, "qa_index", "skipped", "No embeddings adapter configured for QA indexing");
      } else {
        await emit(input, "qa_index", "started", "Building chunk embeddings index", {
          chunkCount: allChunks.length,
        });
        const vectors = await options.embeddings.embed(allChunks.map((chunk) => chunk.text));
        chunkEmbeddings = {};
        for (let index = 0; index < allChunks.length; index += 1) {
          const chunk = allChunks[index];
          const vector = vectors[index];
          if (chunk && vector) {
            chunkEmbeddings[chunk.id] = vector;
          }
        }
        await emit(input, "qa_index", "completed", "QA index ready", {
          indexedChunkCount: Object.keys(chunkEmbeddings).length,
        });
      }

      const storedArtifacts = [
        ...resolved.videos.flatMap((video) => storedArtifactsByVideo.get(video.id) ?? []),
        ...storedAggregateArtifacts,
      ];
      const requestedArtifacts = sortArtifacts(
        storedArtifacts.filter((artifact) => outputs.includes(artifact.kind)),
      );

      const availableTranscriptCount = transcripts.filter((transcript) => isTranscriptUsable(transcript)).length;
      let status: ProcessResult["status"] = availableTranscriptCount === transcripts.length
        ? "ready"
        : availableTranscriptCount === 0
          ? "needs_transcription"
          : "partial";
      if (resolved.sourceResolution?.truncated) {
        status = "partial";
      }

      const processedVideos: Record<string, CourseProcessingState["processedVideos"][string]> = {};
      for (const video of resolved.videos) {
        const transcript = transcripts.find((entry) => entry.videoId === video.id) ?? createEmptyTranscript(video.id);
        processedVideos[video.id] = {
          video,
          fingerprint: fingerprints.get(video.id) ?? createVideoFingerprint(video),
          transcript,
          chunks: chunksByVideo.get(video.id) ?? [],
          artifacts: storedArtifactsByVideo.get(video.id) ?? [],
        };
      }

      const stateToStore: CourseProcessingState = {
        courseId: resolved.courseId,
        source: resolved.source,
        playlist: resolved.playlist,
        videos: resolved.videos,
        transcripts,
        chunks: allChunks,
        artifacts: sortArtifacts(storedArtifacts),
        processedVideos,
        sourceResolution: resolved.sourceResolution,
        chunkEmbeddings,
        sync,
        createdAt: previousState?.createdAt ?? now,
        updatedAt: now,
      };

      await options.storage.set(stateKey, stateToStore);

      await emit(input, "completed", "completed", "Processing complete", {
        courseId: resolved.courseId,
        status,
        videoCount: resolved.videos.length,
        chunkCount: allChunks.length,
        artifactCount: requestedArtifacts.length,
      });

      return {
        courseId: resolved.courseId,
        source: resolved.source,
        playlist: resolved.playlist,
        videos: resolved.videos,
        transcripts,
        chunks: allChunks,
        artifacts: requestedArtifacts,
        status,
        sync,
        sourceResolution: resolved.sourceResolution,
        createdAt: now,
      } satisfies ProcessResult;
    },

    async ask(input: AskAtTimestampInput): Promise<AskResponse> {
      const askResult = askAtTimestampInputSchema.safeParse(input);
      if (!askResult.success) {
        throw new LearnFrameError("INVALID_ASK_INPUT", "Invalid ask input", askResult.error);
      }

      if (options.qa) {
        return options.qa.ask(askResult.data);
      }

      return {
        answer: "I do not have enough context to answer yet because retrieval QA has not been configured.",
        status: "insufficient_context",
        citations: [],
        replayRanges: [],
        followUpQuestions: [],
        confidence: {
          score: 0,
          reason: "Issue #5 only defines SDK foundations; retrieval QA is implemented in issue #7.",
        },
      };
    },

    async exportPack(input) {
      const exportInput = exportPackInputSchema.safeParse(input);
      if (!exportInput.success) {
        throw new LearnFrameError("INVALID_EXPORT_INPUT", "Invalid export input", exportInput.error);
      }

      const stateKey = courseStateKey(exportInput.data.courseId, options.courseStateKeyPrefix);
      const state = await options.storage.get<CourseProcessingState>(stateKey);
      if (!state) {
        throw new LearnFrameError("COURSE_NOT_FOUND", `Course \"${exportInput.data.courseId}\" was not found in storage`);
      }

      try {
        return buildExportPackResult(state);
      } catch (error) {
        throw new LearnFrameError("EXPORT_FAILED", "Failed to generate export pack", error);
      }
    },
  };
}

export const createLearnFrame = createYoutubeLearningSdk;

function normalizeOutputs(outputs: ArtifactKind[] | undefined): ArtifactKind[] {
  if (!outputs || outputs.length === 0) {
    return [];
  }
  return [...new Set(outputs)];
}

function courseStateKey(courseId: string, prefix: string | undefined): string {
  return `${prefix ?? DEFAULT_STATE_KEY_PREFIX}:${courseId}`;
}

function createVideoFingerprint(video: VideoMetadata): string {
  const digest = createHash("sha256");
  digest.update(stableStringify({
    id: video.id,
    url: video.url,
    etag: video.etag,
    durationSeconds: video.durationSeconds,
    publishedAt: video.publishedAt,
    title: video.title,
    availability: video.availability,
  }));
  return digest.digest("hex");
}

function isTranscriptUsable(transcript: Transcript | undefined): transcript is Transcript {
  return Boolean(transcript && transcript.status === "available" && transcript.segments.length > 0);
}

function flattenChunksByVideo(videos: VideoMetadata[], chunksByVideo: Map<string, TranscriptChunk[]>): TranscriptChunk[] {
  const order = new Map(videos.map((video, index) => [video.id, index]));
  return [...videos]
    .flatMap((video) => chunksByVideo.get(video.id) ?? [])
    .sort((left, right) => {
      const leftOrder = order.get(left.videoId) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = order.get(right.videoId) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.startSeconds - right.startSeconds || left.id.localeCompare(right.id);
    });
}

function mergeArtifacts(existing: Artifact[], generated: Artifact[], replacedKinds: ArtifactKind[]): Artifact[] {
  const replaced = new Set(replacedKinds);
  return sortArtifacts([
    ...existing.filter((artifact) => !replaced.has(artifact.kind)),
    ...generated,
  ]);
}

function sortArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((left, right) => {
    return left.kind.localeCompare(right.kind)
      || (left.videoId ?? "").localeCompare(right.videoId ?? "")
      || left.id.localeCompare(right.id);
  });
}

function createTranscriptArtifact(courseId: string, transcript: Transcript): Artifact {
  return {
    id: `${courseId}:transcript:${transcript.videoId}`,
    kind: "transcript",
    courseId,
    videoId: transcript.videoId,
    promptVersion: "transcript-export-v1",
    cacheKey: transcript.provenance?.sourceHash,
    data: {
      status: transcript.status,
      provenance: transcript.provenance,
      segments: transcript.segments,
    },
  };
}

function createEmptyTranscript(videoId: string, status: Transcript["status"] = "missing"): Transcript {
  return {
    videoId,
    status,
    segments: [],
  };
}
