import { z } from "zod";

export const artifactCitationSchema = z.object({
  videoId: z.string().min(1),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().nonnegative(),
  chunkId: z.string().min(1).optional(),
});

export const chunkNotesSchema = z.object({
  chunkId: z.string().min(1),
  videoId: z.string().min(1),
  summary: z.string().min(1),
  keyPoints: z.array(z.string().min(1)),
  concepts: z.array(z.string().min(1)),
  citations: z.array(artifactCitationSchema).min(1),
});

export const videoSummarySchema = z.object({
  videoId: z.string().min(1),
  summary: z.string().min(1),
  keyPoints: z.array(z.string().min(1)),
  citations: z.array(artifactCitationSchema),
});

export const playlistSyllabusSchema = z.object({
  courseId: z.string().min(1),
  title: z.string().min(1),
  modules: z.array(z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    videoIds: z.array(z.string().min(1)),
    outcomes: z.array(z.string().min(1)),
  })),
});

export const glossarySchema = z.object({
  terms: z.array(z.object({
    term: z.string().min(1),
    definition: z.string().min(1),
    citations: z.array(artifactCitationSchema),
  })),
});

export const quizSchema = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    choices: z.array(z.string().min(1)).min(2),
    answer: z.string().min(1),
    explanation: z.string().min(1),
    citations: z.array(artifactCitationSchema),
  })),
});

export const flashcardsSchema = z.object({
  cards: z.array(z.object({
    front: z.string().min(1),
    back: z.string().min(1),
    citations: z.array(artifactCitationSchema),
  })),
});

export const studyPlanSchema = z.object({
  courseId: z.string().min(1),
  steps: z.array(z.object({
    title: z.string().min(1),
    objective: z.string().min(1),
    videoIds: z.array(z.string().min(1)),
  })),
});

export const prerequisiteMapSchema = z.object({
  prerequisites: z.array(z.object({
    concept: z.string().min(1),
    requiredBefore: z.array(z.string().min(1)),
    reason: z.string().min(1),
    citations: z.array(artifactCitationSchema),
  })),
});

export type ArtifactCitationPayload = z.infer<typeof artifactCitationSchema>;
export type ChunkNotesPayload = z.infer<typeof chunkNotesSchema>;
export type VideoSummaryPayload = z.infer<typeof videoSummarySchema>;
export type PlaylistSyllabusPayload = z.infer<typeof playlistSyllabusSchema>;
export type GlossaryPayload = z.infer<typeof glossarySchema>;
export type QuizPayload = z.infer<typeof quizSchema>;
export type FlashcardsPayload = z.infer<typeof flashcardsSchema>;
export type StudyPlanPayload = z.infer<typeof studyPlanSchema>;
export type PrerequisiteMapPayload = z.infer<typeof prerequisiteMapSchema>;
