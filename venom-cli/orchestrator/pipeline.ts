/**
 * VENOM CLI — Agentic Pipeline (Command-Aware)
 *
 * The core execution engine integrated with the slash command system.
 * System prompts from commands are injected into agent configs per-invocation.
 */

import * as readline from "node:readline";
import type { PipelineState, PipelineContext, GeneratedFile } from "./types.js";
import { AGENTS, getAgent } from "./agents.js";
import { NimClient } from "./nim_client.js";
import { PipelineStateMachine, ConversationHistory, createPipelineContext } from "./state.js";
import { extractFileReferences } from "./context.js";
import { extractCodeFiles, writeGeneratedFiles, summarizeChanges } from "./code_writer.js";
import { runDebugLoop } from "./debug_loop.js";
import { Sandbox } from "../core/sandbox.js";

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function askUser(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((r) => rl.question(prompt, r));
}

export class AgenticPipeline {
  private nim: NimClient;
  private sandbox: Sandbox;
  private sm: PipelineStateMachine;
  private history: ConversationHistory;

  constructor(nim: NimClient) {
    this.nim = nim;
    this.sandbox = new Sandbox();
    this.sm = new PipelineStateMachine();
    this.history = new ConversationHistory();
  }

  /** Mode 1: Standalone — Main Agent answers with optional system prompt override. */
  async handleStandalone(userInput: string, systemPromptOverride?: string): Promise<string> {
    this.history.push({ role: "user", content: userInput });

    const agent = systemPromptOverride
      ? getAgent("main", systemPromptOverride)
      : AGENTS.main;

    const response = await this.nim.chatWithProgress(
      agent,
      this.history.getAll(),
      "Thinking"
    );

    this.history.push({ role: "assistant", content: response });
    return response;
  }

  /** Mode 2: Full agentic pipeline with optional command system prompt. */
  async handleAgenticTask(
    userInput: string,
    rl: readline.Interface,
    commandSystemPrompt?: string
  ): Promise<void> {
    const cwd = process.cwd();

    try {
      // ── Prompt Optimization ──
      this.sm.transition("PROMPT_OPTIMIZATION" as PipelineState);
      const { cleaned, context, failedPaths } = extractFileReferences(userInput, cwd);

      if (failedPaths.length > 0) {
        console.log(`\x1b[33m  ⚠ Unresolved: ${failedPaths.join(", ")}\x1b[0m`);
      }

      // Use command's system prompt for main agent if provided
      const mainAgent = commandSystemPrompt
        ? getAgent("main", commandSystemPrompt)
        : AGENTS.main;

      const optimized = await this.nim.chatWithProgress(mainAgent, [{
        role: "user",
        content: `Optimize this request into a dense technical prompt for the Planning Agent.\n\nRequest: ${cleaned}\n\nContext: ${context || "None"}`,
      }], "Optimizing prompt");

      // ── Planning ──
      this.sm.transition("PLANNING" as PipelineState);
      const plan = await this.nim.chatWithProgress(AGENTS.planner, [
        { role: "user", content: optimized },
      ], "Planning architecture");

      // ── Approval Gate ──
      this.sm.transition("USER_APPROVAL" as PipelineState);
      const summary = await this.nim.chatWithProgress(mainAgent, [{
        role: "user",
        content: `Summarize this plan in EXACTLY 2 lines (max 80 chars each).\n\nPlan:\n${plan.slice(0, 3000)}`,
      }], "Summarizing");

      console.log("\n\x1b[1m\x1b[35m┌─── Strategy ───────────────────────────────\x1b[0m");
      for (const line of summary.split("\n").filter(l => l.trim()).slice(0, 2)) {
        console.log(`\x1b[35m│\x1b[0m ${line.trim()}`);
      }
      console.log("\x1b[35m└─────────────────────────────────────────────\x1b[0m\n");

      const answer = await askUser(rl, "\x1b[33mApprove strategy and execute? (yes/changes): \x1b[0m");

      if (answer.toLowerCase().startsWith("y")) {
        // ── Code Generation ──
        this.sm.transition("CODE_GENERATION" as PipelineState);
        const codeOutput = await this.nim.chatWithProgress(AGENTS.coder, [{
          role: "user",
          content: `Generate complete source files for this spec. Use \`\`\`filepath: blocks.\n\n${plan}`,
        }], "Generating code");

        const extraction = extractCodeFiles(codeOutput);
        if (extraction.files.length > 0) {
          console.log(`\n${summarizeChanges(extraction.files)}`);
          writeGeneratedFiles(extraction.files, cwd);
        } else {
          console.log("\n\x1b[36m  Code output:\x1b[0m");
          console.log(codeOutput);
        }

        // ── Debug Loop ──
        this.sm.transition("DEBUGGING" as PipelineState);
        const debug = await runDebugLoop(this.nim, this.sandbox, plan, codeOutput, extraction.files, cwd);

        this.sm.transition("COMPLETED" as PipelineState);

        if (debug.finalVerdict === "PASSED" || debug.finalVerdict === "SKIPPED") {
          console.log("\n\x1b[32m\x1b[1m⬢ VENOM Pipeline Complete — All checks passed.\x1b[0m\n");
        } else if (debug.finalVerdict === "MAX_ITERATIONS") {
          console.log("\n\x1b[33m\x1b[1m⬢ Pipeline Complete — Max iterations reached.\x1b[0m\n");
        } else {
          console.log("\n\x1b[91m\x1b[1m⬢ Pipeline Complete — Issues remain.\x1b[0m\n");
        }
      } else {
        console.log("\x1b[33m  Incorporating feedback...\x1b[0m");
        const feedback = answer.replace(/^(no|changes?)\s*/i, "").trim();
        if (feedback) {
          this.sm.forceState("IDLE" as PipelineState);
          await this.handleAgenticTask(`${userInput}\n\nFeedback: ${feedback}`, rl, commandSystemPrompt);
        } else {
          console.log("\x1b[33m  Provide changes and re-run.\x1b[0m");
        }
      }
    } catch (err) {
      this.sm.forceState("ERROR" as PipelineState);
      console.error(`\n\x1b[91m[PIPELINE ERROR]\x1b[0m ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!this.sm.isIdle) this.sm.forceState("IDLE" as PipelineState);
    }
  }

  /** Headless pipeline for Telegram (auto-approves). */
  async handleHeadless(userInput: string): Promise<string> {
    const { cleaned, context } = extractFileReferences(userInput);
    try {
      const opt = await this.nim.chat(AGENTS.main, [{ role: "user", content: `Optimize: ${cleaned}\nContext: ${context || "None"}` }]);
      const plan = await this.nim.chat(AGENTS.planner, [{ role: "user", content: opt }]);
      const code = await this.nim.chat(AGENTS.coder, [{ role: "user", content: `Generate files:\n\n${plan}` }]);
      const val = await this.nim.chat(AGENTS.debugger, [{ role: "user", content: `Check:\n\n${code.slice(0, 8000)}` }]);
      return `${val.includes("PASSED") ? "✅ Passed" : "⚠️ Issues"}\n\n${code}`;
    } catch (e) {
      return `❌ ${e instanceof Error ? e.message : e}`;
    }
  }

  get currentState(): PipelineState { return this.sm.currentState; }
  get stats() { return { tokens: this.nim.totalTokensUsed, calls: this.nim.totalCalls, history: this.history.length }; }
  clearHistory(): void { this.history.clear(); }
}
