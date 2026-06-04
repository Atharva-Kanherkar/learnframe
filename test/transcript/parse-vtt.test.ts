import { describe, expect, it } from "vitest";
import { normalizeTranscriptCues, parseVtt } from "../../src/index.js";

describe("parseVtt", () => {
  it("parses cues, identifiers, cue settings, NOTE blocks, multiline text, and cue tags", () => {
    const cues = parseVtt(`WEBVTT

NOTE ignored
This block is ignored

cue-1
00:00:01.000 --> 00:00:04.000 align:start line:0%
Hello <b>world</b>
again

STYLE
::cue { color: red; }

00:00:05.500 --> 00:00:07.000
When <00:00:06.000>karaoke &amp; captions
`);

    expect(cues).toEqual([
      { id: "cue-1", startSeconds: 1, endSeconds: 4, text: "Hello <b>world</b>\nagain" },
      { id: undefined, startSeconds: 5.5, endSeconds: 7, text: "When <00:00:06.000>karaoke &amp; captions" },
    ]);
  });

  it("normalizes VTT cues into deterministic transcript segments", () => {
    const segments = normalizeTranscriptCues({
      videoId: "video-1",
      language: "en",
      captionKind: "human",
      cues: parseVtt(`WEBVTT

00:00:01.000 --> 00:00:02.000
Hello <i>world</i> &amp; friends
`),
    });

    expect(segments).toEqual([
      {
        id: "video-1:caption:en:human:0",
        videoId: "video-1",
        startSeconds: 1,
        endSeconds: 2,
        text: "Hello world & friends",
      },
    ]);
  });
});
