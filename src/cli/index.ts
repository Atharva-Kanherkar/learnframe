#!/usr/bin/env node
import * as readline from "node:readline";
import { makeTuiSession, defaultTuiContext, C, paint } from "./tui.js";

const ctx = defaultTuiContext();
const session = makeTuiSession(ctx);

console.log("");
console.log(`  ${paint(C.bold + C.brightCyan, "╭──────────────────────────────────────────╮")}`);
console.log(`  ${paint(C.bold + C.brightCyan, "│")}  ${paint(C.bold, "LearnFrame")} ${paint(C.dim, "— Claude Code for YouTube")}  ${paint(C.bold + C.brightCyan, "│")}`);
console.log(`  ${paint(C.bold + C.brightCyan, "╰──────────────────────────────────────────╯")}`);
console.log(paint(C.dim, "  Type 'help' or process a video to start chatting."));
console.log("");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function getPrompt(): string {
  const state = session.getState();
  if (state.mode === "chat" && state.currentCourse) {
    return paint(C.brightGreen, `${state.currentCourse.slice(0, 20)} › `);
  }
  return paint(C.brightCyan, "cmd › ");
}

rl.setPrompt(getPrompt());
rl.prompt();

rl.on("line", async (line) => {
  try {
    const result = await session.handle(line);
    for (const l of result.lines) {
      if (l === "exit") { rl.close(); return; }
      console.log(`${l}`);
    }
  } catch (e: any) {
    console.log(paint(C.red, `Error: ${e.message}`));
  }
  rl.setPrompt(getPrompt());
  rl.prompt();
});

rl.on("close", () => { console.log(""); process.exit(0); });
