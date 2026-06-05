# feat-video-playback — Test Contract

## Functional Behavior

### `/video` Command
- Accepts optional timestamp: `/video [timestamp]` (same format as `/play`: "123", "2:03", "1:02:30")
- When no course loaded: shows error "No course"
- When course loaded but no video: shows error "No video"
- When course + video available: initiates terminal video playback

### Terminal Video Backends (Auto-Detection)
The `/video` command auto-detects the best available backend in this priority:
1. **kitty** — If `$TERM` contains "kitty" or `$KITTY_WINDOW_ID` is set. Extracts frames via `ffmpeg`, displays inline using kitty graphics protocol escape sequences.
2. **tct** — If `mpv` is available. Launches `mpv --vo=tct --really-quiet --no-terminal <url>` for true-color terminal block rendering.
3. **browser** — Fallback. Opens video URL in system browser (existing `/play` behavior).

### `--backend` Flag
User can override auto-detection: `/video --backend=kitty`, `/video --backend=tct`, `/video --backend=browser`

### Kitty Backend Details
- Spawns `ffmpeg` to extract frames at 2fps to a temp dir
- Uses kitty graphics protocol (`\x1b_G...`) to display frames inline above chat
- Cleans up temp frames on exit/stop
- Stoppable via `/stop` command (already exists) or SIGINT
- Non-blocking — chat remains interactive while video plays

### TCT Backend Details  
- Spawns `mpv --vo=tct --really-quiet --no-terminal <url>`
- mpv renders video as colored Unicode blocks in terminal
- Takes over terminal display area (expected behavior of `--vo=tct`)
- Chat is paused while video plays; returns to chat on mpv exit
- Respects `start` timestamp if provided

### `/stop` Command Enhancement
- If kitty video is playing: stop frame extraction, clear displayed frame, cleanup temp files
- If tct video is playing: send SIGTERM to mpv process
- If neither: show "Nothing playing"

## Unit Tests

- `TestVideoCommand_NoCourse` — `/video` with no course loaded returns error
- `TestVideoCommand_NoVideo` — `/video` with course but no videoId returns error
- `TestVideoCommand_BrowserFallback` — when no kitty/mpv available, opens browser
- `TestVideoCommand_WithTimestamp` — parses "2:30" → 150s start time correctly
- `TestVideoBackend_KittyDetection` — detects kitty terminal from env vars
- `TestVideoBackend_TctDetection` — detects mpv availability
- `TestVideoBackend_BrowserFallback` — fallback when neither kitty nor mpv
- `TestStopCommand_KittyCleanup` — `/stop` clears kitty frames and cleans temp
- `TestStopCommand_TctTermination` — `/stop` sends SIGTERM to mpv process

## Integration / Functional Tests

- `TestKittyFrameExtraction` — `ffmpeg` extracts frames to temp directory
- `TestKittyGraphicsProtocol` — generates valid kitty escape sequences
- `TestMpvTctLaunch` — constructs correct mpv --vo=tct command line

## Smoke Tests

- `npm test` passes (all 117+ existing tests still pass)
- `npm run typecheck` clean
- `npm run build` succeeds
- CLI starts without errors: `node dist/cli/index.js` → shows header + prompt

## E2E Tests

- Manual: `learnframe` → `process <url>` → `/video` → video plays in terminal
- Manual: `learnframe` → `process <url>` → `/video --backend=kitty` → frames display inline
- Manual: `learnframe` → `process <url>` → `/video --backend=tct` → mpv color blocks render
- Manual: `/stop` while video playing → playback stops, chat resumes

## Manual / cURL Tests

N/A — CLI feature, no HTTP endpoints.

## Edge Cases

- ffmpeg not installed → gracefully fall back to tct or browser
- mpv not installed → fall back to browser
- kitty terminal but ffmpeg missing → fall back to tct or browser
- Very long video → frame extraction should be throttled/capped
- Terminal resize during kitty playback → frame should adapt or be cleared
- Multiple `/video` calls without `/stop` → previous playback is stopped first
