import type { PlayerState, PlayerStateAdapter, SeekTarget } from "../contracts.js";

export type PlayerDriver = {
  getVideoId(): string;
  getCurrentTime(): number;
  isPlaying(): boolean;
  getDuration(): number | undefined;
  seekTo(seconds: number): void;
  onStateChange(callback: (state: PlayerState) => void): () => void;
};

export function createPlayerStateAdapter(driver: PlayerDriver): PlayerStateAdapter {
  return {
    getState(): PlayerState {
      return {
        videoId: driver.getVideoId(),
        currentTimeSeconds: driver.getCurrentTime(),
        isPlaying: driver.isPlaying(),
        durationSeconds: driver.getDuration(),
      };
    },

    seek(target: SeekTarget): void {
      if (target.videoId !== driver.getVideoId()) {
        return;
      }
      driver.seekTo(target.timestampSeconds);
    },

    subscribe(callback: (state: PlayerState) => void): () => void {
      return driver.onStateChange(callback);
    },
  };
}
