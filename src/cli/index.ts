#!/usr/bin/env node
import * as readline from "node:readline";
import { makeTuiSession, defaultTuiContext, C, colored } from "./tui.js";

const ctx = defaultTuiContext();
const session = makeTuiSession(ctx);

console.log("");
console.log(`  ${colored(C.bold, "LearnFrame")} ${colored(C.dim, "— YouTube to learning pipeline")}`);
console.log(colored(C.dim, "  Type 'help' for commands, 'process <url>' to start, 'exit' to quit."));
console.log("");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt(colored(C.cyan, "› "));
rl.prompt();

rl.on("line", async (line) => {
  try {
    const result = await session.handle(line);
    for (const l of result.lines) {
      if (l === "exit") { rl.close(); return; }
      console.log(`  ${l}`);
    }
  } catch (e: any) {
    console.log(`  ${colored(C.red, `Error: ${e.message}`)}`);
  }
  rl.prompt();
});

rl.on("close", () => { console.log(""); process.exit(0); });
