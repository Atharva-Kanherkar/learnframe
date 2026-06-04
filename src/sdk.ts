import type {
  AdapterContext,
  AskAtTimestampInput,
  AskResponse,
  LearnFrameSdk,
  LearnFrameSdkOptions,
  ProcessInput,
  ProcessResult,
  ProgressEvent,
  ProgressStage,
  ProgressStatus,
} from "./contracts.js";
import { LearnFrameError } from "./contracts.js";
import { askAtTimestampInputSchema, sourceSchema } from "./schemas.js";

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

      try {
        const resolved = await options.sourceResolver.resolve(sourceResult.data, createContext(input));
        await emit(input, "source_resolution", "completed", "YouTube source resolved", {
          courseId: resolved.courseId,
          videoCount: resolved.videos.length,
        });
        await emit(input, "completed", "completed", "SDK foundation processing completed");

        return {
          courseId: resolved.courseId,
          source: resolved.source,
          playlist: resolved.playlist,
          videos: resolved.videos,
          artifacts: [],
          status: resolved.sourceResolution?.truncated ? "partial" : "ready",
          sourceResolution: resolved.sourceResolution,
          createdAt: new Date().toISOString(),
        } satisfies ProcessResult;
      } catch (error) {
        await emit(input, "source_resolution", "failed", "YouTube source resolution failed");
        if (error instanceof LearnFrameError) {
          throw error;
        }
        throw new LearnFrameError("RESOLUTION_FAILED", "YouTube source resolution failed", error);
      }
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
  };
}

export const createLearnFrame = createYoutubeLearningSdk;
