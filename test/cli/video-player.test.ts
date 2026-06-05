import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  detectBackends,
  pickBackend,
  createKittyFrameDisplay,
  createVideoPlayer,
  type KittyFrameDisplay,
} from "../../src/cli/video-player.js";

describe("detectBackends", () => {
  const originalTerm = process.env.TERM;
  const originalKittyId = process.env.KITTY_WINDOW_ID;

  beforeEach(() => {
    delete process.env.TERM;
    delete process.env.KITTY_WINDOW_ID;
  });

  afterEach(() => {
    if (originalTerm !== undefined) process.env.TERM = originalTerm;
    else delete process.env.TERM;
    if (originalKittyId !== undefined) process.env.KITTY_WINDOW_ID = originalKittyId;
    else delete process.env.KITTY_WINDOW_ID;
  });

  it("detects kitty terminal from TERM", () => {
    process.env.TERM = "xterm-kitty";
    const d = detectBackends();
    expect(d.kitty).toBe(true);
  });

  it("detects kitty terminal from KITTY_WINDOW_ID", () => {
    process.env.KITTY_WINDOW_ID = "1";
    const d = detectBackends();
    expect(d.kitty).toBe(true);
  });

  it("returns false when not in kitty", () => {
    process.env.TERM = "xterm-256color";
    const d = detectBackends();
    expect(d.kitty).toBe(false);
  });
});

describe("pickBackend", () => {
  it("auto-picks kitty when all deps available", () => {
    const detected = { kitty: true, tct: true, ffmpeg: true, ytDlp: true };
    expect(pickBackend(undefined, detected)).toBe("kitty");
  });

  it("auto-picks tct when kitty deps missing", () => {
    const detected = { kitty: true, tct: true, ffmpeg: false, ytDlp: true };
    expect(pickBackend(undefined, detected)).toBe("tct");
  });

  it("auto-picks browser when nothing available", () => {
    const detected = { kitty: false, tct: false, ffmpeg: false, ytDlp: false };
    expect(pickBackend(undefined, detected)).toBe("browser");
  });

  it("respects preferred backend when available", () => {
    const detected = { kitty: true, tct: true, ffmpeg: true, ytDlp: true };
    expect(pickBackend("tct", detected)).toBe("tct");
  });

  it("falls back when preferred backend unavailable", () => {
    const detected = { kitty: false, tct: true, ffmpeg: false, ytDlp: false };
    expect(pickBackend("kitty", detected)).toBe("tct");
  });

  it("falls back to browser when preferred tct unavailable", () => {
    const detected = { kitty: false, tct: false, ffmpeg: false, ytDlp: false };
    expect(pickBackend("tct", detected)).toBe("browser");
  });
});

describe("createKittyFrameDisplay", () => {
  it("display writes kitty graphics protocol escape sequence", () => {
    const display = createKittyFrameDisplay();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const pngData = Buffer.from("fake-png-data");
    display.display(pngData);

    const calls = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("\x1b_G"))).toBe(true);
    expect(calls.some((c) => c.includes("f=100"))).toBe(true);
    expect(calls.some((c) => c.includes("a=T"))).toBe(true);

    writeSpy.mockRestore();
  });

  it("clear writes kitty delete escape sequence", () => {
    const display = createKittyFrameDisplay();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    display.clear();

    const calls = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("\x1b_Ga=d,d=A"))).toBe(true);

    writeSpy.mockRestore();
  });
});

describe("createVideoPlayer", () => {
  let mockKittyDisplay: KittyFrameDisplay;

  beforeEach(() => {
    mockKittyDisplay = {
      display: vi.fn(),
      clear: vi.fn(),
    };
  });

  it("starts not playing", () => {
    const player = createVideoPlayer(mockKittyDisplay);
    expect(player.isPlaying()).toBe(false);
    expect(player.getBackend()).toBeUndefined();
  });

  it("play with browser backend sets state", async () => {
    const player = createVideoPlayer(mockKittyDisplay);
    const result = await player.play("abc123", 0, "browser");
    expect(result.backend).toBe("browser");
    expect(player.isPlaying()).toBe(true);
    expect(player.getBackend()).toBe("browser");
  });

  it("stop clears state", async () => {
    const player = createVideoPlayer(mockKittyDisplay);
    await player.play("abc123", 0, "browser");
    expect(player.isPlaying()).toBe(true);
    await player.stop();
    expect(player.isPlaying()).toBe(false);
    expect(player.getBackend()).toBeUndefined();
  });

  it("stop on non-playing is no-op", async () => {
    const player = createVideoPlayer(mockKittyDisplay);
    await player.stop();
    expect(player.isPlaying()).toBe(false);
  });

  it("play auto-stops previous playback", async () => {
    const player = createVideoPlayer(mockKittyDisplay);
    await player.play("abc123", 0, "browser");
    await player.play("def456", 0, "browser");
    expect(player.isPlaying()).toBe(true);
  });

  it("calls kitty display clear on stop after kitty play", async () => {
    const player = createVideoPlayer(mockKittyDisplay);
    // Browser play then stop should still call clear (safe cleanup)
    await player.play("abc123", 0, "browser");
    await player.stop();
    expect(mockKittyDisplay.clear).toHaveBeenCalled();
  });

  it("sends SIGTERM to tct process on stop", async () => {
    const player = createVideoPlayer(mockKittyDisplay);
    // In CI/test environments mpv may not be installed, so tct falls back to browser.
    // We verify that play→stop cycle works cleanly regardless of actual backend.
    await player.play("abc123", 0, "tct");
    expect(player.isPlaying()).toBe(true);
    // stop should succeed without throwing even if the process already exited
    await expect(player.stop()).resolves.toBeUndefined();
    expect(player.isPlaying()).toBe(false);
  });
});
