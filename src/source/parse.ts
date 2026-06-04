import { LearnFrameError } from "../contracts.js";

export type ParsedYoutubeUrlKind = "video" | "playlist" | "videoWithPlaylist";

export type ParsedYoutubeUrl = {
  kind: ParsedYoutubeUrlKind;
  originalUrl: string;
  canonicalUrl: string;
  videoId?: string;
  playlistId?: string;
  warnings: string[];
};

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

export function parseYoutubeUrl(input: string): ParsedYoutubeUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new LearnFrameError("INVALID_SOURCE", "Invalid YouTube URL", error);
  }

  const host = url.hostname.toLowerCase();
  const warnings: string[] = [];
  let videoId: string | undefined;
  let playlistId: string | undefined;

  if (host === "youtu.be") {
    videoId = firstPathSegment(url);
    playlistId = searchValue(url, "list");
  } else if (YOUTUBE_HOSTS.has(host)) {
    const path = normalizePath(url.pathname);
    if (path === "/watch") {
      videoId = searchValue(url, "v");
      playlistId = searchValue(url, "list");
    } else if (path.startsWith("/shorts/")) {
      videoId = pathSegment(url, 1);
      playlistId = searchValue(url, "list");
    } else if (path === "/playlist") {
      playlistId = searchValue(url, "list");
    }
  } else {
    throw new LearnFrameError("INVALID_SOURCE", "URL must be a YouTube URL");
  }

  if (!videoId && !playlistId) {
    throw new LearnFrameError("INVALID_SOURCE", "YouTube URL must include a video or playlist id");
  }

  if (host === "music.youtube.com") {
    warnings.push("music.youtube.com URLs are treated as YouTube URLs for source resolution.");
  }

  const kind: ParsedYoutubeUrlKind = videoId && playlistId ? "videoWithPlaylist" : videoId ? "video" : "playlist";

  return {
    kind,
    originalUrl: input,
    canonicalUrl: createCanonicalYoutubeUrl(videoId, playlistId, kind),
    videoId,
    playlistId,
    warnings,
  };
}

export function createCanonicalYoutubeUrl(
  videoId: string | undefined,
  playlistId: string | undefined,
  kind: ParsedYoutubeUrlKind,
): string {
  if (kind === "playlist") {
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(requiredId(playlistId, "playlist"))}`;
  }

  const canonical = new URL("https://www.youtube.com/watch");
  canonical.searchParams.set("v", requiredId(videoId, "video"));
  if (kind === "videoWithPlaylist" && playlistId) {
    canonical.searchParams.set("list", playlistId);
  }
  return canonical.toString();
}

function requiredId(value: string | undefined, label: string): string {
  if (!value) {
    throw new LearnFrameError("INVALID_SOURCE", `Missing YouTube ${label} id`);
  }
  return value;
}

function searchValue(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value || undefined;
}

function firstPathSegment(url: URL): string | undefined {
  return pathSegment(url, 0);
}

function pathSegment(url: URL, index: number): string | undefined {
  const value = normalizePath(url.pathname).split("/").filter(Boolean)[index]?.trim();
  return value || undefined;
}

function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/u, "");
  return normalized || "/";
}
