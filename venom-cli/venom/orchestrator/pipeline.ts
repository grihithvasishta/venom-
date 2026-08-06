/**
 * VENOM CLI — Agentic Pipeline
 *
 * The core execution engine that coordinates the 4-agent cluster through
 * the full lifecycle: prompt optimization → planning → approval gate →
 * code generation → autonomous debugging.
 *
 * Supports two modes:
 *   Mode 1 (Standalone): Main Agent responds directly to simple queries.
 *   Mode 2 (Agentic):    Full multi-agent pipeline with debug loops.
 */

import * as readline from "node:readline";
import type {
  PipelineState,
  PipelineContext,
  GeneratedFile,
} from "./types.js";
import { AGENTS } from "./agents.js";
import { NimClient } from "./nim_client.js";
import {
  PipelineStateMachine,
  ConversationHistory,
  createPipelineContext,
} from "./state.js";
import { extractFileReferences } from "./context.js";
import {
  extractCodeFiles,
  writeGeneratedFiles,
  summarizeChanges,
} from "./code_writer.js";
import { runDebugLoop } from "./debug_loop.js";
import { Sandbox } from "../sandbox.js";

// ---------------------------------------------------------------------------
// Pipeline Events (for external consumers like Telegram)
// ---------------------------------------------------------------------------

export type PipelineEventType =
  | "state_change"
  | "progress"
  | "plan_ready"
  | "code_ready"
  | "debug_update"
  | "completed"
  | "error";

export interface PipelineEvent {
  type: PipelineEventType;
  message: string;
  data?: unknown;
}

export type PipelineEventListener = (event: PipelineEvent) => void;

// ---------------------------------------------------------------------------
// User Prompt Helper
// ---------------------------------------------------------------------------

function askUser(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

// ---------------------------------------------------------------------------
// Agentic Pipeline
// ---------------------------------------------------------------------------

export class AgenticPipeline {
  private nim: NimClient;
  private sandbox: Sandbox;
  private stateMachine: PipelineStateMachine;
  private history: ConversationHistory;
  private eventListeners: PipelineEventListener[] = [];

  constructor(nim: NimClient) {
    this.nim = nim;
    this.sandbox = new Sandbox();
    this.stateMachine = new PipelineStateMachine();
    this.history = new ConversationHistory();

    // Wire state machine events to pipeline events
    this.stateMachine.onStateChange((from, to) => {
      this.emit({
        type: "state_change",
        message: `${from} → ${to}`,
        data: { from, to },
      });
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Mode 1: Standalone — Main Agent answers directly. */
  async handleStandalone(userInput: string): Promise<string> {
    this.history.push({ role: "user", content: userInput });

    const response = await this.nim.chatWithProgress(
      AGENTS.main,
      this.history.getAll(),
      "Thinking"
    );

    this.history.push({ role: "assistant", content: response });

    return response;
  }

  /**
   * Mode 2: Full agentic pipeline.
   * Orchestrates the complete lifecycle from prompt to validated code.
   */
  async handleAgenticTask(
    userInput: string,
    rl: readline.Interface
  ): Promise<void> {
    const cwd = process.cwd();
    const ctx = createPipelineContext(userInput, cwd);

    try {
      // ── Step 1: Prompt Optimization ──────────────────────────────────
      this.stateMachine.transition("PROMPT_OPTIMIZATION" as PipelineState);
      this.emit({
        type: "progress",
        message: "Optimizing prompt...",
      });

      const { cleaned, context, failedPaths } =
        extractFileReferences(userInput, cwd);

      if (failedPaths.length > 0) {
        console.log(
          `\x1b[33m  ⚠ Could not resolve: ${failedPaths.join(", ")}\x1b[0m`
        );
      }

      const optimizedPrompt = await this.nim.chatWithProgress(
        AGENTS.main,
        [
          {
            role: "user",
            content:
              `Optimize this user request into a dense, precise technical prompt for the Planning Agent. Include any file context provided.\n\n` +
              `User Request: ${cleaned}\n\n` +
              `File Context: ${context || "None"}`,
          },
        ],
        "Optimizing prompt"
      );
      ctx.optimizedPrompt = optimizedPrompt;

      // ── Step 2: Architecture Planning ────────────────────────────────
      this.stateMachine.transition("PLANNING" as PipelineState);
      this.emit({
        type: "progress",
        message: "Planning architecture...",
      });

      const plan = await this.nim.chatWithProgress(
        AGENTS.planner,
        [{ role: "user", content: optimizedPrompt }],
        "Planning architecture"
      );
      ctx.plan = plan;

      // ── Step 3: User Approval Gate ───────────────────────────────────
      this.stateMachine.transition("USER_APPROVAL" as PipelineState);

      const summary = await this.nim.chatWithProgress(
        AGENTS.main,
        [
          {
            role: "user",
            content:
              `Summarize this technical plan in EXACTLY 2 lines (max 80 chars each). Be specific about what will be built.\n\n` +
              `Plan:\n${plan.slice(0, 3000)}`,
          },
        ],
        "Summarizing plan"
      );
      ctx.planSummary = summary;

      this.emit({
        type: "plan_ready",
        message: summary,
        data: { plan },
      });

      // Display strategy box
      this.renderStrategyBox(summary);

      const approved = await askUser(
        rl,
        "\x1b[33mApprove strategy and execute? (yes/changes): \x1b[0m"
      );

      if (approved.toLowerCase().startsWith("y")) {
        await this.executeApprovedPlan(ctx, plan, cwd, rl);
      } else {
        await this.handlePlanRejection(ctx, userInput, approved, rl);
      }
    } catch (error) {
      this.stateMachine.forceState("ERROR" as PipelineState);
      const errMsg = error instanceof Error ? error.message : String(error);
      ctx.error = error instanceof Error ? error : new Error(errMsg);

      this.emit({
        type: "error",
        message: errMsg,
        data: { error },
      });

      console.error(`\n\x1b[91m[PIPELINE ERROR]\x1b[0m ${errMsg}`);
    } finally {
      if (!this.stateMachine.isIdle) {
        this.stateMachine.forceState("IDLE" as PipelineState);
      }
    }
  }

  /**
   * Handle an agentic task programmatically (no readline — used by Telegram).
   * Returns the final code output or error message.
   */
  async handleAgenticTaskHeadless(userInput: string): Promise<string> {
    const cwd = process.cwd();

    try {
      // Prompt optimization
      const { cleaned, context } = extractFileReferences(userInput, cwd);

      const optimizedPrompt = await this.nim.chat(AGENTS.main, [
        {
          role: "user",
          content: `Optimize this user request into a dense, precise technical prompt for the Planning Agent.\n\nUser Request: ${cleaned}\n\nFile Context: ${context || "None"}`,
        },
      ]);

      // Planning
      const plan = await this.nim.chat(AGENTS.planner, [
        { role: "user", content: optimizedPrompt },
      ]);

      // Code generation (auto-approve in headless mode)
      const codeOutput = await this.nim.chat(AGENTS.coder, [
        {
          role: "user",
          content: `Generate complete source files based on this specification. Output each file in a fenced block with filepath: prefix.\n\n${plan}`,
        },
      ]);

      // Validation
      const validation = await this.nim.chat(AGENTS.debugger, [
        {
          role: "user",
          content: `Static analysis — check this code for errors:\n\n${codeOutput.slice(0, 8000)}`,
        },
      ]);

      const status = validation.includes("PASSED")
        ? "✅ Validation passed"
        : "⚠️ Issues detected";

      return `${status}\n\n${codeOutput}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `❌ Pipeline error: ${errMsg}`;
    }
  }

  /** Register a pipeline event listener. */
  onEvent(listener: PipelineEventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  /** Get current pipeline state. */
  get currentState(): PipelineState {
    return this.stateMachine.currentState;
  }

  /** Get session stats. */
  get stats(): { tokens: number; calls: number; historySize: number } {
    return {
      tokens: this.nim.totalTokensUsed,
      calls: this.nim.totalCalls,
      historySize: this.history.length,
    };
  }

  // ── Private Methods ──────────────────────────────────────────────────────

  private async executeApprovedPlan(
    ctx: PipelineContext,
    plan: string,
    cwd: string,
    rl: readline.Interface
  ): Promise<void> {
    // ── Step 4: Code Generation ──────────────────────────────────
    this.stateMachine.transition("CODE_GENERATION" as PipelineState);
    this.emit({
      type: "progress",
      message: "Generating code...",
    });

    const codeOutput = await this.nim.chatWithProgress(
      AGENTS.coder,
      [
        {
          role: "user",
          content: `Generate complete source files based on this technical specification. Output each file in a fenced code block with filepath: prefix.\n\n${plan}`,
        },
      ],
      "Generating code"
    );
    ctx.codeOutput = codeOutput;

    const extraction = extractCodeFiles(codeOutput);
    ctx.generatedFiles = extraction.files;

    if (extraction.files.length > 0) {
      console.log(`\n${summarizeChanges(extraction.files)}`);
      const writeResult = writeGeneratedFiles(extraction.files, cwd);

      if (writeResult.failed.length > 0) {
        console.log(
          `\n\x1b[91m  ${writeResult.failed.length} file(s) failed to write.\x1b[0m`
        );
      }

      this.emit({
        type: "code_ready",
        message: `${extraction.files.length} file(s) generated`,
        data: { files: extraction.files },
      });
    } else {
      console.log("\n\x1b[36m  Code output:\x1b[0m");
      console.log(codeOutput);
    }

    // ── Step 5: Autonomous Debugging Loop ────────────────────────
    this.stateMachine.transition("DEBUGGING" as PipelineState);
    this.emit({
      type: "progress",
      message: "Starting debug loop...",
    });

    const debugSummary = await runDebugLoop(
      this.nim,
      this.sandbox,
      plan,
      codeOutput,
      extraction.files,
      cwd
    );
    ctx.debugSummary = debugSummary;

    this.emit({
      type: "debug_update",
      message: `Debug complete: ${debugSummary.finalVerdict}`,
      data: { summary: debugSummary },
    });

    // ── Complete ─────────────────────────────────────────────────
    this.stateMachine.transition("COMPLETED" as PipelineState);
    this.emit({
      type: "completed",
      message: "Pipeline complete",
      data: ctx,
    });

    this.renderCompletionBanner(debugSummary.finalVerdict);
  }

  private async handlePlanRejection(
    ctx: PipelineContext,
    userInput: string,
    response: string,
    rl: readline.Interface
  ): Promise<void> {
    console.log("\x1b[33m  Incorporating feedback...\x1b[0m");

    const feedback = response.replace(/^(no|changes?)\s*/i, "").trim();
    if (feedback) {
      // Re-enter pipeline with user feedback
      this.stateMachine.forceState("IDLE" as PipelineState);
      await this.handleAgenticTask(
        `${userInput}\n\nUser feedback on plan: ${feedback}`,
        rl
      );
    } else {
      console.log(
        "\x1b[33m  Provide your changes and re-run the command.\x1b[0m"
      );
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private renderStrategyBox(summary: string): void {
    console.log(
      "\n\x1b[1m\x1b[35m┌─── Strategy ───────────────────────────────\x1b[0m"
    );
    const lines = summary
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 2);
    for (const line of lines) {
      console.log(`\x1b[35m│\x1b[0m ${line.trim()}`);
    }
    console.log(
      "\x1b[35m└─────────────────────────────────────────────\x1b[0m\n"
    );
  }

  private renderCompletionBanner(
    verdict: string
  ): void {
    if (verdict === "PASSED" || verdict === "SKIPPED") {
      console.log(
        "\n\x1b[32m\x1b[1m⬢ VENOM Pipeline Complete — All checks passed.\x1b[0m\n"
      );
    } else if (verdict === "MAX_ITERATIONS") {
      console.log(
        "\n\x1b[33m\x1b[1m⬢ VENOM Pipeline Complete — Max iterations reached (review recommended).\x1b[0m\n"
      );
    } else {
      console.log(
        "\n\x1b[91m\x1b[1m⬢ VENOM Pipeline Complete — Issues remain (manual review needed).\x1b[0m\n"
      );
    }
  }

  // ── Event Emitter ────────────────────────────────────────────────────────

  private emit(event: PipelineEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Listeners should not crash the pipeline
      }
    }
  }
}
