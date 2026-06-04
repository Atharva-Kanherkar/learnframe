import type { PlaylistMetadata, ResolvedYoutubeSource, VideoMetadata, YoutubeSource } from "../contracts.js";
import { parseYoutubeUrl } from "./parse.js";

export type DedupeVideoMetadataResult = {
  videos: VideoMetadata[];
  duplicateCount: number;
};

export type NormalizeResolvedYoutubeSourceInput = {
  source: YoutubeSource;
  playlist: Omit<PlaylistMetadata, "videos"> & { videos?: VideoMetadata[] };
  videos: VideoMetadata[];
};

export type NormalizeResolvedYoutubeSourceResult = ResolvedYoutubeSource & {
  duplicateCount: number;
  unavailableCount: number;
};

export function dedupeVideoMetadata(videos: VideoMetadata[]): DedupeVideoMetadataResult {
  const seen = new Set<string>();
  const deduped: VideoMetadata[] = [];
  let duplicateCount = 0;

  for (const video of videos) {
    if (seen.has(video.id)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(video.id);
    deduped.push(video);
  }

  return { videos: deduped, duplicateCount };
}

export function normalizeResolvedYoutubeSource(
  input: NormalizeResolvedYoutubeSourceInput,
): NormalizeResolvedYoutubeSourceResult {
  const { videos, duplicateCount } = dedupeVideoMetadata(
    input.videos.map((video, index) => ({
      ...video,
      position: video.position ?? index,
    })),
  );
  const unavailableCount = videos.filter((video) => video.availability !== "available").length;
  const parsed = parseYoutubeUrl(input.source.url);
  const playlistId = input.playlist.id || parsed.playlistId || parsed.videoId || parsed.canonicalUrl;
  const playlist: PlaylistMetadata = {
    ...input.playlist,
    id: playlistId,
    videos,
  };

  return {
    courseId: `youtube-course:${playlist.id}`,
    source: input.source,
    playlist,
    videos,
    duplicateCount,
    unavailableCount,
  };
}
