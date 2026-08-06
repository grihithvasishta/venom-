/**
 * VENOM CLI — Interactive REPL
 *
 * Terminal-based read-eval-print loop that handles user input routing,
 * slash command parsing, and session lifecycle. This is the user-facing
 * interface layer — all heavy logic is delegated to the pipeline.
 */

import * as readline from "node:readline";
import { NimClient } from "./nim_client.js";
import { AgenticPipeline } from "./pipeline.js";
import { AGENTIC_TRIGGERS } from "./types.js";

// ---------------------------------------------------------------------------
// Command Parsing
// ---------------------------------------------------------------------------

interface ParsedCommand {
  triggered: boolean;
  command: string;
  body: string;
}

/**
 * Parse user input to determine if it's an agentic slash command.
 */
export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();

  for (const trigger of AGENTIC_TRIGGERS) {
    if (trimmed.startsWith(trigger)) {
      return {
        triggered: true,
        command: trigger,
        body: trimmed.slice(trigger.length).trim(),
      };
    }
  }

  return { triggered: false, command: "", body: trimmed };
}

// ---------------------------------------------------------------------------
// Help Text
// ---------------------------------------------------------------------------

const HELP_TEXT = `
\x1b[1m\x1b[35m╔══════════════════════════════════════════════╗\x1b[0m
\x1b[1m\x1b[35m║           VENOM — Command Reference          ║\x1b[0m
\x1b[1m\x1b[35m╠══════════════════════════════════════════════╣\x1b[0m
\x1b[35m║\x1b[0m                                              \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m  \x1b[36m/code <task>\x1b[0m  Agentic coding pipeline      \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m  \x1b[36m/vibe <task>\x1b[0m  Alias for /code              \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m  \x1b[36m/build <task>\x1b[0m Alias for /code              \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m  \x1b[36m@filename\x1b[0m     Include file context         \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m  \x1b[36m/stats\x1b[0m        Show session statistics      \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m  \x1b[36m/clear\x1b[0m        Clear conversation history   \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m  \x1b[36m/help\x1b[0m         Show this help               \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m  \x1b[36m/exit\x1b[0m         Exit VENOM                   \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m                                              \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m  \x1b[90mOr type any question for standalone mode.\x1b[0m   \x1b[35m║\x1b[0m
\x1b[35m║\x1b[0m                                              \x1b[35m║\x1b[0m
\x1b[1m\x1b[35m╚══════════════════════════════════════════════╝\x1b[0m
`;

// ---------------------------------------------------------------------------
// REPL Session
// ---------------------------------------------------------------------------

export class ReplSession {
  private rl: readline.Interface;
  private pipeline: AgenticPipeline;
  private isProcessing: boolean = false;

  constructor(pipeline: AgenticPipeline) {
    this.pipeline = pipeline;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\x1b[35m❯ venom \x1b[0m",
      terminal: true,
    });
  }

  /** Start the interactive REPL loop. */
  async start(): Promise<void> {
    this.printWelcome();
    this.rl.prompt();

    this.rl.on("line", async (line: string) => {
      if (this.isProcessing) {
        console.log(
          "\x1b[33m  Processing previous request... please wait.\x1b[0m"
        );
        return;
      }

      await this.handleLine(line);
      this.rl.prompt();
    });

    this.rl.on("close", () => {
      this.printGoodbye();
      process.exit(0);
    });
  }

  // ── Line Handler ─────────────────────────────────────────────────────────

  private async handleLine(line: string): Promise<void> {
    const input = line.trim();

    if (!input) return;

    // Built-in commands
    switch (input) {
      case "/exit":
      case "/quit":
      case "/q":
        this.printGoodbye();
        this.rl.close();
        process.exit(0);

      case "/help":
      case "/h":
      case "/?":
        console.log(HELP_TEXT);
        return;

      case "/stats":
        this.printStats();
        return;

      case "/clear":
        this.clearHistory();
        return;
    }

    // Parse for agentic triggers
    const { triggered, body } = parseCommand(input);

    this.isProcessing = true;

    try {
      if (triggered) {
        if (!body) {
          console.log(
            "\x1b[33m  Provide a task description after the command.\x1b[0m\n"
          );
        } else {
          await this.pipeline.handleAgenticTask(body, this.rl);
        }
      } else {
        const response = await this.pipeline.handleStandalone(input);
        console.log(`\n${response}\n`);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`\x1b[91m[ERROR]\x1b[0m ${errMsg}\n`);
    } finally {
      this.isProcessing = false;
    }
  }

  // ── Display Helpers ──────────────────────────────────────────────────────

  private printWelcome(): void {
    console.log(
      "\x1b[90m  Type a question for standalone mode, or use /code /vibe /build for agentic mode.\x1b[0m"
    );
    console.log(
      "\x1b[90m  Use @filename to include file context. Type /help for commands.\x1b[0m\n"
    );
  }

  private printGoodbye(): void {
    const stats = this.pipeline.stats;
    console.log("\n\x1b[33m[VENOM]\x1b[0m Session ended.");

    if (stats.calls > 0) {
      console.log(
        `\x1b[90m  Session stats: ${stats.calls} API calls, ~${stats.tokens} tokens used.\x1b[0m`
      );
    }

    console.log("");
  }

  private printStats(): void {
    const stats = this.pipeline.stats;
    console.log(`
\x1b[1m\x1b[35m  Session Statistics\x1b[0m
  \x1b[36mAPI Calls:\x1b[0m        ${stats.calls}
  \x1b[36mTokens Used:\x1b[0m      ~${stats.tokens}
  \x1b[36mHistory Size:\x1b[0m     ${stats.historySize} messages
  \x1b[36mPipeline State:\x1b[0m   ${this.pipeline.currentState}
`);
  }

  private clearHistory(): void {
    // Pipeline will handle its own history clear
    console.log("\x1b[32m  Conversation history cleared.\x1b[0m\n");
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and start a new REPL session.
 */
export async function startREPL(apiKey: string): Promise<void> {
  if (!apiKey) {
    console.log(
      "\x1b[91m[VENOM]\x1b[0m NVIDIA_NIM_API_KEY not set.\n" +
        "  Set it via:  export NVIDIA_NIM_API_KEY=your_key_here\n" +
        "  Or pass:     venom --api-key YOUR_KEY\n"
    );
    console.log(
      "\x1b[33m[VENOM]\x1b[0m Running in offline mode (commands will show errors).\n"
    );
  }

  const nim = new NimClient(apiKey);
  const pipeline = new AgenticPipeline(nim);
  const session = new ReplSession(pipeline);
  await session.start();
}
