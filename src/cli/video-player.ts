import { spawn, execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { exec } from "node:child_process";

const execAsync = promisify(exec);

export type VideoBackend = "kitty" | "tct" | "browser";

export interface VideoPlayerState {
  playing: boolean;
  backend?: VideoBackend;
  process?: ReturnType<typeof spawn>;
  frameDir?: string;
  frameInterval?: ReturnType<typeof setInterval>;
}

export interface DetectedBackends {
  kitty: boolean;
  tct: boolean;
  ffmpeg: boolean;
  ytDlp: boolean;
}

export function detectBackends(): DetectedBackends {
  let kitty = false;
  let tct = false;
  let ffmpeg = false;
  let ytDlp = false;

  try {
    kitty = !!(process.env.TERM?.includes("kitty") || process.env.KITTY_WINDOW_ID);
  } catch { /* noop */ }

  try {
    execSync("which mpv", { stdio: "ignore" });
    tct = true;
  } catch { /* noop */ }

  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    ffmpeg = true;
  } catch { /* noop */ }

  try {
    execSync("which yt-dlp", { stdio: "ignore" });
    ytDlp = true;
  } catch {
    try {
      execSync("which youtube-dl", { stdio: "ignore" });
      ytDlp = true;
    } catch { /* noop */ }
  }

  return { kitty, tct, ffmpeg, ytDlp };
}

export function pickBackend(
  preferred: VideoBackend | undefined,
  detected: DetectedBackends,
): VideoBackend {
  if (preferred) {
    if (preferred === "kitty" && detected.kitty && detected.ffmpeg && detected.ytDlp) return "kitty";
    if (preferred === "tct" && detected.tct) return "tct";
    if (preferred === "browser") return "browser";
    // Preferred unavailable — fall through to auto
  }
  if (detected.kitty && detected.ffmpeg && detected.ytDlp) return "kitty";
  if (detected.tct) return "tct";
  return "browser";
}

export interface KittyFrameDisplay {
  display(pngData: Buffer): void;
  clear(): void;
}

export function createKittyFrameDisplay(): KittyFrameDisplay {
  return {
    display(pngData: Buffer) {
      const b64 = pngData.toString("base64");
      const chunkSize = 4096;
      const chunks: string[] = [];
      for (let i = 0; i < b64.length; i += chunkSize) {
        chunks.push(b64.slice(i, i + chunkSize));
      }

      // Clear previous frame
      process.stdout.write("\x1b_Ga=d,d=A\x1b\\");

      if (chunks.length === 1) {
        process.stdout.write(`\x1b_Gf=100,a=T,t=d;${chunks[0]}\x1b\\`);
      } else {
        for (let i = 0; i < chunks.length; i++) {
          const m = i === chunks.length - 1 ? 0 : 1;
          process.stdout.write(`\x1b_Gm=${m},f=100,a=T,t=d;${chunks[i]}\x1b\\`);
        }
      }
    },
    clear() {
      process.stdout.write("\x1b_Ga=d,d=A\x1b\\");
    },
  };
}

export interface VideoPlayer {
  play(videoId: string, startSeconds: number, preferredBackend?: VideoBackend): Promise<{ backend: VideoBackend; message: string }>;
  stop(): Promise<void>;
  isPlaying(): boolean;
  getBackend(): VideoBackend | undefined;
}

export function createVideoPlayer(
  kittyDisplay: KittyFrameDisplay = createKittyFrameDisplay(),
): VideoPlayer {
  let state: VideoPlayerState = { playing: false };

  async function play(
    videoId: string,
    startSeconds: number,
    preferredBackend?: VideoBackend,
  ): Promise<{ backend: VideoBackend; message: string }> {
    await stop();

    const detected = detectBackends();
    const backend = pickBackend(preferredBackend, detected);
    const url = `https://youtube.com/watch?v=${videoId}`;

    if (backend === "browser") {
      const platform = process.platform;
      const cmd =
        platform === "darwin"
          ? `open "${url}&t=${startSeconds}s"`
          : platform === "win32"
            ? `start "${url}&t=${startSeconds}s"`
            : `xdg-open "${url}&t=${startSeconds}s"`;
      exec(cmd);
      state = { playing: true, backend: "browser" };
      return { backend: "browser", message: "Opened in browser" };
    }

    if (backend === "tct") {
      const child = spawn(
        "mpv",
        ["--vo=tct", "--really-quiet", "--no-terminal", `--start=${startSeconds}`, url],
        { stdio: ["ignore", "pipe", "pipe"], detached: false },
      );

      child.stdout?.pipe(process.stdout);
      // Do not pipe stderr to avoid noise

      state = { playing: true, backend: "tct", process: child };
      return { backend: "tct", message: "Playing with mpv tct (color blocks). Type /stop to quit." };
    }

    // backend === "kitty"
    let streamUrl: string;
    try {
      const ytdlpCmd = detected.ytDlp ? "yt-dlp" : "youtube-dl";
      const { stdout } = await execAsync(`${ytdlpCmd} -g "${url}"`);
      streamUrl = stdout.trim().split("\n")[0];
    } catch {
      // Fallback if stream extraction fails
      if (detected.tct) {
        return play(videoId, startSeconds, "tct");
      }
      return play(videoId, startSeconds, "browser");
    }

    const frameDir = mkdtempSync(join(tmpdir(), "learnframe-kitty-"));

    const ffmpegProc = spawn(
      "ffmpeg",
      [
        "-ss",
        String(startSeconds),
        "-i",
        streamUrl,
        "-vf",
        "fps=2,scale=480:-1:flags=lanczos",
        "-f",
        "image2",
        join(frameDir, "frame-%04d.png"),
      ],
      { stdio: "ignore" },
    );

    // Allow ffmpeg to buffer a few frames
    await new Promise((r) => setTimeout(r, 2000));

    let frameIndex = 1;
    const interval = setInterval(() => {
      const files = readdirSync(frameDir)
        .filter((f) => f.endsWith(".png"))
        .sort();

      if (files.length === 0) return;

      const target = Math.min(frameIndex - 1, files.length - 1);
      const frameFile = join(frameDir, files[target]);
      if (existsSync(frameFile)) {
        try {
          const data = readFileSync(frameFile);
          kittyDisplay.display(data);
        } catch { /* frame might be mid-write */ }
      }

      frameIndex++;
      if (frameIndex > files.length) {
        frameIndex = 1; // loop
      }

      // Stop if ffmpeg exited and we've looped through all frames
      if (ffmpegProc.exitCode !== null && frameIndex >= files.length) {
        clearInterval(interval);
      }
    }, 500);

    state = { playing: true, backend: "kitty", frameDir, frameInterval: interval };
    return { backend: "kitty", message: "Playing inline (kitty graphics). Type /stop to quit." };
  }

  async function stop(): Promise<void> {
    if (!state.playing) return;

    if (state.process) {
      try {
        state.process.kill("SIGTERM");
      } catch { /* noop */ }
    }

    if (state.frameInterval) {
      clearInterval(state.frameInterval);
    }

    if (state.frameDir) {
      try {
        rmSync(state.frameDir, { recursive: true, force: true });
      } catch { /* noop */ }
    }
    kittyDisplay.clear();

    state = { playing: false };
  }

  function isPlaying(): boolean {
    return state.playing;
  }

  function getBackend(): VideoBackend | undefined {
    return state.backend;
  }

  return { play, stop, isPlaying, getBackend };
}
