/**
 * DEPRECATED — This file has been decomposed into the orchestrator/ directory.
 *
 * The orchestrator is now a multi-module package:
 *   orchestrator/
 *   ├── index.ts        — Boot entry point & barrel exports
 *   ├── types.ts        — Shared types, interfaces, enums
 *   ├── agents.ts       — 4-agent cluster configuration
 *   ├── nim_client.ts   — NVIDIA NIM API client
 *   ├── context.ts      — File context extraction (@ references)
 *   ├── code_writer.ts  — Code file extraction & disk writer
 *   ├── state.ts        — Pipeline state machine & history
 *   ├── debug_loop.ts   — Autonomous debug cycle
 *   ├── pipeline.ts     — Core agentic pipeline engine
 *   └── repl.ts         — Interactive terminal REPL
 *
 * Entry point: venom/orchestrator/index.ts
 * This file is kept only for reference. Do NOT import from here.
 */

export * from "./orchestrator/index.js";
