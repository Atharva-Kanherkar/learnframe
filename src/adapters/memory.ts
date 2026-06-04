import type {
  AdapterContext,
  ResolvedYoutubeSource,
  SourceResolver,
  StorageAdapter,
  VideoMetadata,
  YoutubeSource,
} from "../contracts.js";

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

      const videos = source.type === "video" ? [createVideoMetadata(source, 0, options)] : [];
      const playlistId = source.type === "playlist" ? source.playlistId ?? stableId("playlist", source.url) : stableId("playlist", source.url);
      const resolvedVideos = videos.length > 0 ? videos : [createVideoMetadata({ type: "video", url: source.url, language: source.language }, 0, options)];
      const playlist = {
        id: playlistId,
        url: source.url,
        videos: resolvedVideos,
      };

      await context.reportProgress({
        stage: "source_resolution",
        status: "completed",
        message: "Source resolved with in-memory resolver",
        data: { videoCount: resolvedVideos.length },
      });

      return {
        courseId: `youtube-course:${playlist.id}`,
        source,
        playlist,
        videos: resolvedVideos,
      };
    },
  };
}

function createVideoMetadata(
  source: Extract<YoutubeSource, { type: "video" }>,
  position: number,
  options: InMemorySourceResolverOptions,
): VideoMetadata {
  const id = source.videoId ?? extractVideoId(source.url) ?? stableId("video", source.url);
  const override = options.videos?.[id] ?? {};

  return {
    id,
    url: source.url,
    position,
    availability: "available",
    ...override,
  };
}

function extractVideoId(url: string): string | undefined {
  const match = url.match(/[?&]v=([^&]+)/) ?? url.match(/youtu\.be\/([^?]+)/) ?? url.match(/shorts\/([^?]+)/);
  return match?.[1];
}

function stableId(prefix: string, input: string): string {
  return `${prefix}:${encodeURIComponent(input)}`;
}
