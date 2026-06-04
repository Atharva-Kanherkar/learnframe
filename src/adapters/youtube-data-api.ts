import type {
  AdapterContext,
  ResolvedYoutubeSource,
  SourceResolver,
  VideoAvailability,
  VideoMetadata,
  YoutubeSource,
} from "../contracts.js";
import { LearnFrameError } from "../contracts.js";
import { createSourceResolutionCacheKey } from "../source/keys.js";
import { normalizeResolvedYoutubeSource } from "../source/normalize.js";
import { parseYoutubeUrl } from "../source/parse.js";

export type YoutubeDataApiSourceResolverOptions = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  maxPages?: number;
  providerName?: string;
};

type YoutubeListResponse<T> = {
  etag?: string;
  nextPageToken?: string;
  items?: T[];
};

type YoutubePlaylistItem = {
  snippet?: {
    title?: string;
    description?: string;
    position?: number;
    resourceId?: { videoId?: string };
    thumbnails?: Record<string, { url?: string }>;
  };
};

type YoutubeVideoItem = {
  id?: string;
  etag?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  contentDetails?: {
    duration?: string;
  };
  status?: {
    privacyStatus?: string;
  };
};

export function createYoutubeDataApiSourceResolver(options: YoutubeDataApiSourceResolverOptions): SourceResolver {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const provider = options.providerName ?? "youtube-data-api";
  const maxPages = options.maxPages ?? 100;

  return {
    async resolve(source: YoutubeSource, context: AdapterContext): Promise<ResolvedYoutubeSource> {
      if (!fetchImpl) {
        throw new LearnFrameError("RESOLUTION_FAILED", "No fetch implementation available for YouTube Data API resolver");
      }

      const parsed = parseYoutubeUrl(source.url);
      const cacheKey = createSourceResolutionCacheKey({ provider, source, parsed, options: { maxPages } });
      const cached = await context.storage.get<ResolvedYoutubeSource>(cacheKey);
      if (cached) {
        await context.reportProgress({
          stage: "source_resolution",
          status: "skipped",
          message: "Using cached YouTube source resolution",
          data: { cacheKey, videoCount: cached.videos.length },
        });
        return cached;
      }

      const result = source.type === "playlist"
        ? await resolvePlaylist(source, parsed.playlistId, fetchImpl, options.apiKey, maxPages, context)
        : await resolveVideo(source, parsed.videoId, fetchImpl, options.apiKey);

      const normalized = normalizeResolvedYoutubeSource(result);
      const resolved: ResolvedYoutubeSource = {
        courseId: normalized.courseId,
        source: normalized.source,
        playlist: normalized.playlist,
        videos: normalized.videos,
      };

      await context.storage.set(cacheKey, resolved);
      await context.reportProgress({
        stage: "source_resolution",
        status: "completed",
        message: "YouTube Data API source resolved",
        data: {
          cacheKey,
          videoCount: normalized.videos.length,
          duplicateCount: normalized.duplicateCount,
          unavailableCount: normalized.unavailableCount,
        },
      });

      return resolved;
    },
  };
}

async function resolveVideo(
  source: YoutubeSource,
  videoId: string | undefined,
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
) {
  if (!videoId) {
    throw new LearnFrameError("INVALID_SOURCE", "Video source must include a video id");
  }

  const response = await fetchJson<YoutubeListResponse<YoutubeVideoItem>>(fetchImpl, "videos", apiKey, {
    id: videoId,
    part: "snippet,contentDetails,status",
    fields: "items(id,etag,snippet(title,description,channelId,channelTitle,publishedAt),contentDetails(duration),status(privacyStatus))",
  });
  const video = response.items?.[0];
  const metadata = video ? mapVideoItem(video, 0) : createUnavailableVideo(videoId, 0);

  return {
    source,
    playlist: {
      id: videoId,
      url: source.url,
      title: metadata.title,
    },
    videos: [metadata],
  };
}

async function resolvePlaylist(
  source: YoutubeSource,
  playlistId: string | undefined,
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  maxPages: number,
  context: AdapterContext,
) {
  if (!playlistId) {
    throw new LearnFrameError("INVALID_SOURCE", "Playlist source must include a playlist id");
  }

  const playlistItems: YoutubePlaylistItem[] = [];
  let pageToken: string | undefined;
  let page = 0;

  do {
    page += 1;
    const response = await fetchJson<YoutubeListResponse<YoutubePlaylistItem>>(fetchImpl, "playlistItems", apiKey, {
      playlistId,
      maxResults: "50",
      pageToken,
      part: "snippet",
      fields: "nextPageToken,items(snippet(title,description,position,resourceId(videoId)))",
    });

    playlistItems.push(...(response.items ?? []));
    pageToken = response.nextPageToken;

    await context.reportProgress({
      stage: "source_resolution",
      status: "completed",
      message: "Resolved YouTube playlist page",
      data: { page, itemCount: playlistItems.length, hasNextPage: Boolean(pageToken) },
    });
  } while (pageToken && page < maxPages);

  const ids = playlistItems.map((item) => item.snippet?.resourceId?.videoId).filter((id): id is string => Boolean(id));
  const detailMap = await fetchVideoDetails(ids, fetchImpl, apiKey);
  const videos = playlistItems.flatMap((item, index) => {
    const id = item.snippet?.resourceId?.videoId;
    if (!id) {
      return [];
    }
    const detail = detailMap.get(id);
    return detail ? [mapVideoItem(detail, item.snippet?.position ?? index)] : [createUnavailableVideo(id, item.snippet?.position ?? index, item)];
  });

  return {
    source,
    playlist: {
      id: playlistId,
      url: source.url,
    },
    videos,
  };
}

async function fetchVideoDetails(
  ids: string[],
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
): Promise<Map<string, YoutubeVideoItem>> {
  const uniqueIds = [...new Set(ids)];
  const details = new Map<string, YoutubeVideoItem>();

  for (let index = 0; index < uniqueIds.length; index += 50) {
    const batch = uniqueIds.slice(index, index + 50);
    const response = await fetchJson<YoutubeListResponse<YoutubeVideoItem>>(fetchImpl, "videos", apiKey, {
      id: batch.join(","),
      part: "snippet,contentDetails,status",
      fields: "items(id,etag,snippet(title,description,channelId,channelTitle,publishedAt),contentDetails(duration),status(privacyStatus))",
    });

    for (const item of response.items ?? []) {
      if (item.id) {
        details.set(item.id, item);
      }
    }
  }

  return details;
}

async function fetchJson<T>(
  fetchImpl: typeof globalThis.fetch,
  resource: "videos" | "playlistItems",
  apiKey: string,
  params: Record<string, string | undefined>,
): Promise<T> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetchImpl(url, {
    headers: {
      "Accept-Encoding": "gzip",
      "User-Agent": "learnframe (gzip)",
    },
  });
  if (!response.ok) {
    throw new LearnFrameError("RESOLUTION_FAILED", `YouTube Data API request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

function mapVideoItem(item: YoutubeVideoItem, position: number): VideoMetadata {
  const id = item.id;
  if (!id) {
    throw new LearnFrameError("RESOLUTION_FAILED", "YouTube Data API video item is missing an id");
  }

  return {
    id,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
    title: item.snippet?.title,
    description: item.snippet?.description,
    durationSeconds: parseYoutubeDuration(item.contentDetails?.duration),
    channelId: item.snippet?.channelId,
    channelTitle: item.snippet?.channelTitle,
    publishedAt: item.snippet?.publishedAt,
    position,
    availability: mapAvailability(item.status?.privacyStatus),
    etag: item.etag,
  };
}

function createUnavailableVideo(id: string, position: number, playlistItem?: YoutubePlaylistItem): VideoMetadata {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
    title: playlistItem?.snippet?.title,
    description: playlistItem?.snippet?.description,
    position,
    availability: mapUnavailablePlaylistItem(playlistItem),
  };
}

function mapAvailability(privacyStatus: string | undefined): VideoAvailability {
  if (privacyStatus === "private") {
    return "private";
  }
  return "available";
}

function mapUnavailablePlaylistItem(item: YoutubePlaylistItem | undefined): VideoAvailability {
  const title = item?.snippet?.title?.toLowerCase() ?? "";
  if (title.includes("deleted")) {
    return "deleted";
  }
  if (title.includes("private")) {
    return "private";
  }
  return "unavailable";
}

function parseYoutubeDuration(duration: string | undefined): number | undefined {
  if (!duration) {
    return undefined;
  }
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u);
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}
