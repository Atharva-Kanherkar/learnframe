import type {
  AdapterContext,
  PlaylistMetadata,
  ResolvedYoutubeSource,
  SourceResolver,
  StorageAdapter,
  VideoMetadata,
  YoutubeSource,
} from "../contracts.js";
import { normalizeResolvedYoutubeSource } from "../source/normalize.js";
import { parseYoutubeUrl } from "../source/parse.js";

export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.values.has(key);
  }
}

export function createInMemoryStorage(): StorageAdapter {
  return new InMemoryStorageAdapter();
}

export type InMemorySourceResolverOptions = {
  playlists?: Record<string, Partial<PlaylistMetadata> & { videos: VideoMetadata[] }>;
  videos?: Record<string, Partial<VideoMetadata>>;
};

export function createInMemorySourceResolver(options: InMemorySourceResolverOptions = {}): SourceResolver {
  return {
    async resolve(source: YoutubeSource, context: AdapterContext): Promise<ResolvedYoutubeSource> {
      await context.reportProgress({
        stage: "source_resolution",
        status: "started",
        message: "Resolving source with in-memory resolver",
      });

      const parsed = parseYoutubeUrl(source.url);
      const playlistId = source.type === "playlist" ? source.playlistId ?? parsed.playlistId ?? stableId("playlist", source.url) : stableId("playlist", parsed.videoId ?? source.url);
      const fixturePlaylist = options.playlists?.[playlistId];
      const rawVideos = fixturePlaylist?.videos ?? [createVideoMetadata({ type: "video", url: source.url, videoId: parsed.videoId, language: source.language }, 0, options)];
      const normalized = normalizeResolvedYoutubeSource({
        source,
        playlist: {
          id: playlistId,
          url: source.url,
          title: fixturePlaylist?.title,
          description: fixturePlaylist?.description,
        },
        videos: rawVideos,
      });

      await context.reportProgress({
        stage: "source_resolution",
        status: "completed",
        message: "Source resolved with in-memory resolver",
        data: {
          videoCount: normalized.videos.length,
          duplicateCount: normalized.duplicateCount,
          unavailableCount: normalized.unavailableCount,
        },
      });

      return {
        courseId: normalized.courseId,
        source,
        playlist: normalized.playlist,
        videos: normalized.videos,
      };
    },
  };
}

function createVideoMetadata(
  source: Extract<YoutubeSource, { type: "video" }>,
  position: number,
  options: InMemorySourceResolverOptions,
): VideoMetadata {
  const id = source.videoId ?? parseYoutubeUrl(source.url).videoId ?? stableId("video", source.url);
  const override = options.videos?.[id] ?? {};

  return {
    id,
    url: source.url,
    position,
    availability: "available",
    ...override,
  };
}

function stableId(prefix: string, input: string): string {
  return `${prefix}:${encodeURIComponent(input)}`;
}
