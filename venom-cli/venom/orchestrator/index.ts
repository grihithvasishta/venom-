/**
 * VENOM CLI — Orchestrator Index
 *
 * Central barrel export and boot entry point for the orchestrator module.
 * This file is the single entry point that main.py launches via Node.js.
 *
 * Architecture:
 *   orchestrator/
 *   ├── index.ts        ← You are here (boot + re-exports)
 *   ├── types.ts        ← Shared types, interfaces, enums, constants
 *   ├── agents.ts       ← 4-agent cluster configuration & registry
 *   ├── nim_client.ts   ← NVIDIA NIM API client (retry, streaming, progress)
 *   ├── context.ts      ← File context extraction (@ references)
 *   ├── code_writer.ts  ← Code file extraction & disk writer
 *   ├── state.ts        ← Pipeline state machine & conversation history
 *   ├── debug_loop.ts   ← Autonomous debug cycle
 *   ├── pipeline.ts     ← Core agentic pipeline execution engine
 *   └── repl.ts         ← Interactive terminal REPL
 */

// ── Re-exports (public API) ───────────────────────────────────────────────

export type {
  ChatMessage,
  NimResponse,
  AgentRole,
  AgentConfig,
  PipelineState,
  StateTransition,
  GeneratedFile,
  CodeExtractionResult,
  FileContextResult,
  DebugIterationResult,
  DebugLoopSummary,
  PipelineContext,
} from "./types.js";

export {
  NIM_BASE_URL,
  MAX_DEBUG_ITERATIONS,
  MAX_HISTORY_LENGTH,
  AGENTIC_TRIGGERS,
} from "./types.js";

export { AGENTS, getAgent, agentDisplayName, listAgentRoles } from "./agents.js";

export { NimClient, NimApiError, NimEmptyResponseError } from "./nim_client.js";

export { extractFileReferences } from "./context.js";

export {
  extractCodeFiles,
  writeGeneratedFiles,
  summarizeChanges,
} from "./code_writer.js";

export {
  PipelineStateMachine,
  ConversationHistory,
  createPipelineContext,
  updateContext,
} from "./state.js";

export { runDebugLoop } from "./debug_loop.js";

export type {
  PipelineEvent,
  PipelineEventType,
  PipelineEventListener,
} from "./pipeline.js";
export { AgenticPipeline } from "./pipeline.js";

export { ReplSession, parseCommand, startREPL } from "./repl.js";

// ── Boot Sequence ─────────────────────────────────────────────────────────

import { playBootAnimation } from "../canvas.js";
import { startREPL } from "./repl.js";

async function boot(): Promise<void> {
  // Play the animated ASCII spider + VENOM logo
  await playBootAnimation();

  // Launch the interactive REPL
  const apiKey = process.env.NVIDIA_NIM_API_KEY || "";
  await startREPL(apiKey);
}

// Only run boot when this is the main module
boot().catch((err) => {
  console.error(`\x1b[91m[VENOM FATAL]\x1b[0m ${err}`);
  process.exit(1);
});
