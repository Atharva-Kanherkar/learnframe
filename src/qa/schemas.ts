import { z } from "zod";

export const answerCitationSchema = z.object({
  videoId: z.string().min(1),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().nonnegative(),
  chunkId: z.string().min(1).optional(),
  text: z.string().optional(),
}).refine((citation) => citation.endSeconds >= citation.startSeconds, {
  message: "Citation endSeconds must be greater than or equal to startSeconds",
  path: ["endSeconds"],
});

export const timestampRangeSchema = z.object({
  videoId: z.string().min(1),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().nonnegative(),
}).refine((range) => range.endSeconds >= range.startSeconds, {
  message: "Range endSeconds must be greater than or equal to startSeconds",
  path: ["endSeconds"],
});

export const answerSchema = z.object({
  answer: z.string().min(1),
  status: z.enum(["answered", "insufficient_context"]),
  citations: z.array(answerCitationSchema),
  replayRanges: z.array(timestampRangeSchema),
  followUpQuestions: z.array(z.string()),
  confidence: z.object({
    score: z.number().min(0).max(1),
    reason: z.string().min(1),
  }),
}).refine((answer) => answer.status === "insufficient_context" || answer.citations.length > 0, {
  message: "Answered responses must include at least one citation",
  path: ["citations"],
});

export type AnswerPayload = z.infer<typeof answerSchema>;
