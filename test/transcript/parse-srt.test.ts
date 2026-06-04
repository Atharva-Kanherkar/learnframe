import { describe, expect, it } from "vitest";
import { parseSrt } from "../../src/index.js";

describe("parseSrt", () => {
  it("parses numbered cues, comma milliseconds, and multiline text", () => {
    expect(parseSrt(`1
00:00:02,000 --> 00:00:06,000
Subtitle 1.1
Subtitle 1.2

2
00:00:28,967 --> 01:30:30,958
Subtitle 2.1
Subtitle 2.2
`)).toEqual([
      { id: "1", startSeconds: 2, endSeconds: 6, text: "Subtitle 1.1\nSubtitle 1.2" },
      { id: "2", startSeconds: 28.967, endSeconds: 5430.958, text: "Subtitle 2.1\nSubtitle 2.2" },
    ]);
  });
});
