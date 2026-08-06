/**
 * VENOM CLI — Interactive REPL (Command-Integrated)
 *
 * Routes user input through the command registry and dispatches
 * to the appropriate pipeline mode with the correct system prompt.
 */

import * as readline from "node:readline";
import { NimClient } from "./nim_client.js";
import { AgenticPipeline } from "./pipeline.js";
import {
  resolveCommand,
  isPipelineCommand,
  isStandaloneAiCommand,
  getStandaloneMode,
  generateHelpText,
  listCommands,
} from "../commands/index.js";

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

export class ReplSession {
  private rl: readline.Interface;
  private pipeline: AgenticPipeline;
  private busy = false;

  constructor(pipeline: AgenticPipeline) {
    this.pipeline = pipeline;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\x1b[35m❯ venom \x1b[0m",
      terminal: true,
    });
  }

  async start(): Promise<void> {
    console.log("\x1b[90m  Type any question, or use a slash command. /help for commands.\x1b[0m\n");
    this.rl.prompt();

    this.rl.on("line", async (line: string) => {
      if (this.busy) {
        console.log("\x1b[33m  Processing... please wait.\x1b[0m");
        return;
      }
      await this.handle(line);
      this.rl.prompt();
    });

    this.rl.on("close", () => {
      this.printGoodbye();
      process.exit(0);
    });
  }

  private async handle(line: string): Promise<void> {
    const input = line.trim();
    if (!input) return;

    // Built-in commands
    if (input === "/exit" || input === "/quit" || input === "/q") {
      this.printGoodbye();
      this.rl.close();
      process.exit(0);
    }
    if (input === "/help" || input === "/h" || input === "/?") {
      console.log(generateHelpText());
      return;
    }
    if (input === "/stats") {
      this.printStats();
      return;
    }
    if (input === "/clear") {
      this.pipeline.clearHistory();
      console.log("\x1b[32m  History cleared.\x1b[0m\n");
      return;
    }

    this.busy = true;

    try {
      // Try to resolve as a slash command
      const resolved = resolveCommand(input);

      if (resolved) {
        const { command, body } = resolved;
        const result = await command.execute({
          body,
          cwd: process.cwd(),
          rl: this.rl,
        });

        if (!result.success) {
          if (!result.alreadyPrinted && result.output) console.log(result.output);
          return;
        }

        if (result.output === "__PIPELINE__") {
          // Full agentic pipeline with command's system prompt
          await this.pipeline.handleAgenticTask(body, this.rl, command.systemPrompt);
        } else if (isStandaloneAiCommand(result.output || "")) {
          // Standalone AI query with command's system prompt
          const response = await this.pipeline.handleStandalone(body, command.systemPrompt);
          console.log(`\n${response}\n`);
        } else if (!result.alreadyPrinted && result.output) {
          console.log(result.output);
        }
      } else {
        // No slash command — default standalone mode
        const response = await this.pipeline.handleStandalone(input);
        console.log(`\n${response}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[91m[ERROR]\x1b[0m ${msg}\n`);
    } finally {
      this.busy = false;
    }
  }

  private printStats(): void {
    const s = this.pipeline.stats;
    console.log(`
\x1b[1m\x1b[35m  Session Statistics\x1b[0m
  \x1b[36mAPI Calls:\x1b[0m        ${s.calls}
  \x1b[36mTokens Used:\x1b[0m      ~${s.tokens}
  \x1b[36mHistory:\x1b[0m          ${s.history} messages
  \x1b[36mState:\x1b[0m            ${this.pipeline.currentState}
`);
  }

  private printGoodbye(): void {
    const s = this.pipeline.stats;
    console.log("\n\x1b[33m[VENOM]\x1b[0m Session ended.");
    if (s.calls > 0) console.log(`\x1b[90m  ${s.calls} calls, ~${s.tokens} tokens.\x1b[0m`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function startREPL(apiKey: string): Promise<void> {
  if (!apiKey) {
    console.log(
      "\x1b[91m[VENOM]\x1b[0m NVIDIA_NIM_API_KEY not set.\n" +
      "  export NVIDIA_NIM_API_KEY=your_key\n"
    );
    console.log("\x1b[33m[VENOM]\x1b[0m Running in offline mode.\n");
  }

  const nim = new NimClient(apiKey);
  const pipeline = new AgenticPipeline(nim);
  const session = new ReplSession(pipeline);
  await session.start();
}
