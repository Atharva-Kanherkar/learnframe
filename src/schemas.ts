import { z } from "zod";

export const youtubeVideoSourceSchema = z.object({
  type: z.literal("video"),
  url: z.string().url(),
  videoId: z.string().min(1).optional(),
  language: z.string().min(2).optional(),
});

export const youtubePlaylistSourceSchema = z.object({
  type: z.literal("playlist"),
  url: z.string().url(),
  playlistId: z.string().min(1).optional(),
  language: z.string().min(2).optional(),
});

export const sourceSchema = z.discriminatedUnion("type", [
  youtubeVideoSourceSchema,
  youtubePlaylistSourceSchema,
]);

export const askAtTimestampInputSchema = z.object({
  courseId: z.string().min(1),
  videoId: z.string().min(1).optional(),
  timestampSeconds: z.number().nonnegative().optional(),
  selectedText: z.string().optional(),
  question: z.string().min(1),
});

export const exportPackInputSchema = z.object({
  courseId: z.string().min(1),
});

export type ParsedYoutubeSource = z.infer<typeof sourceSchema>;
export type ParsedAskAtTimestampInput = z.infer<typeof askAtTimestampInputSchema>;
export type ParsedExportPackInput = z.infer<typeof exportPackInputSchema>;
