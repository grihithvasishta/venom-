/**
 * VENOM CLI — Orchestrator Index
 *
 * Boot entry point and barrel exports.
 * This is the file Node.js executes when venom launches.
 *
 * Top-level structure:
 *   core/           — canvas, sandbox, safety
 *   orchestrator/   — agents, nim_client, pipeline, state, repl (you are here)
 *   commands/       — slash command handlers (/code, /write, /shell, etc.)
 *   gateway/        — telegram bot
 *   native/         — C N-API module
 *   venom/          — Python package
 */

// Re-exports
export type { ChatMessage, AgentRole, AgentConfig, PipelineState, GeneratedFile, PipelineContext } from "./types.js";
export { NIM_BASE_URL, ALLOWED_MODELS, MAX_DEBUG_ITERATIONS } from "./types.js";
export { AGENTS, getAgent } from "./agents.js";
export { NimClient, NimApiError, ModelNotAllowedError } from "./nim_client.js";
export { extractFileReferences } from "./context.js";
export { extractCodeFiles, writeGeneratedFiles } from "./code_writer.js";
export { PipelineStateMachine, ConversationHistory } from "./state.js";
export { runDebugLoop } from "./debug_loop.js";
export { AgenticPipeline } from "./pipeline.js";
export { ReplSession, startREPL } from "./repl.js";

// ── Boot ──────────────────────────────────────────────────────────────────

import { playBootAnimation } from "../core/canvas.js";
import { startREPL } from "./repl.js";

async function boot(): Promise<void> {
  await playBootAnimation();
  const apiKey = process.env.NVIDIA_NIM_API_KEY || "";
  await startREPL(apiKey);
}

boot().catch((err) => {
  console.error(`\x1b[91m[VENOM FATAL]\x1b[0m ${err}`);
  process.exit(1);
});
