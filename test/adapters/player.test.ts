import { describe, expect, it, vi } from "vitest";
import { createPlayerStateAdapter } from "../../src/index.js";
import type { PlayerDriver } from "../../src/adapters/player.js";

function createFakeDriver(overrides: Partial<PlayerDriver> = {}): PlayerDriver & { _state: { videoId: string; currentTime: number; playing: boolean; duration: number | undefined } } {
  const state = {
    videoId: "video-1",
    currentTime: 612,
    playing: false,
    duration: 1200 as number | undefined,
  };

  return {
    _state: state,
    getVideoId: () => state.videoId,
    getCurrentTime: () => state.currentTime,
    isPlaying: () => state.playing,
    getDuration: () => state.duration,
    seekTo: (seconds: number) => { state.currentTime = seconds; },
    onStateChange: (_callback: (s: Parameters<PlayerDriver["onStateChange"]>[0]) => void) => () => {},
    ...overrides,
  };
}

describe("createPlayerStateAdapter", () => {
  it("returns current player state", () => {
    const driver = createFakeDriver();
    const adapter = createPlayerStateAdapter(driver);

    const state = adapter.getState();

    expect(state).toEqual({
      videoId: "video-1",
      currentTimeSeconds: 612,
      isPlaying: false,
      durationSeconds: 1200,
    });
  });

  it("seek seeks within the current video", () => {
    const driver = createFakeDriver();
    const adapter = createPlayerStateAdapter(driver);

    adapter.seek({ videoId: "video-1", timestampSeconds: 780 });

    expect(driver._state.currentTime).toBe(780);
  });

  it("seek ignores requests for a different videoId", () => {
    const driver = createFakeDriver();
    const adapter = createPlayerStateAdapter(driver);

    adapter.seek({ videoId: "video-2", timestampSeconds: 999 });

    expect(driver._state.currentTime).toBe(612);
  });

  it("subscribe calls back on state changes and returns an unsubscribe function", () => {
    const callbacks: Array<(s: Parameters<PlayerDriver["onStateChange"]>[0]) => void> = [];
    const driver = createFakeDriver({
      onStateChange: (cb) => {
        callbacks.push(cb);
        return () => {
          const index = callbacks.indexOf(cb);
          if (index !== -1) callbacks.splice(index, 1);
        };
      },
    });

    const listener = vi.fn();
    const adapter = createPlayerStateAdapter(driver);
    const unsub = adapter.subscribe(listener);

    callbacks.forEach((cb) => cb({ videoId: "video-1", currentTimeSeconds: 700, isPlaying: true, durationSeconds: 1200 }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      videoId: "video-1",
      currentTimeSeconds: 700,
      isPlaying: true,
      durationSeconds: 1200,
    });

    unsub();
    listener.mockClear();

    callbacks.forEach((cb) => cb({ videoId: "video-1", currentTimeSeconds: 800, isPlaying: false, durationSeconds: 1200 }));

    expect(listener).not.toHaveBeenCalled();
  });

  it("exports PlayerStateAdapter contract types from the package root", async () => {
    const mod = await import("../../src/index.js");
    expect(mod).toBeDefined();
  });
});
