/**
 * VENOM CLI — Command Registry
 *
 * Central registry for all slash commands. Handles command resolution
 * (including aliases), help text generation, and system prompt lookup.
 */

import type { SlashCommand, CommandContext, CommandResult } from "./types.js";
import codeCommand from "./code.js";
import writeCommand from "./write.js";
import shellCommand from "./shell.js";
import buildCommand from "./build.js";
import vibeCommand from "./vibe.js";
import debugCommand from "./debug.js";
import planCommand from "./plan.js";
import askCommand from "./ask.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All registered commands. */
const ALL_COMMANDS: SlashCommand[] = [
  codeCommand,
  writeCommand,
  shellCommand,
  buildCommand,
  vibeCommand,
  debugCommand,
  planCommand,
  askCommand,
];

/** Lookup map: command name or alias → SlashCommand. */
const COMMAND_MAP = new Map<string, SlashCommand>();

for (const cmd of ALL_COMMANDS) {
  COMMAND_MAP.set(cmd.name, cmd);
  for (const alias of cmd.aliases) {
    COMMAND_MAP.set(alias, cmd);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a slash command by name or alias.
 * Returns null if not found.
 */
export function resolveCommand(input: string): {
  command: SlashCommand;
  body: string;
} | null {
  const trimmed = input.trim();

  // Check each registered command and alias
  for (const [trigger, cmd] of COMMAND_MAP) {
    if (trimmed === trigger || trimmed.startsWith(trigger + " ")) {
      return {
        command: cmd,
        body: trimmed.slice(trigger.length).trim(),
      };
    }
  }

  return null;
}

/**
 * Get the system prompt for a resolved command.
 */
export function getCommandSystemPrompt(commandName: string): string | null {
  const cmd = COMMAND_MAP.get(commandName);
  return cmd ? cmd.systemPrompt : null;
}

/**
 * Check if the resolved command triggers the full agentic pipeline.
 */
export function isPipelineCommand(resultOutput: string): boolean {
  return resultOutput === "__PIPELINE__";
}

/**
 * Check if the resolved command is a standalone (non-pipeline) AI query.
 */
export function isStandaloneAiCommand(resultOutput: string): boolean {
  return resultOutput.startsWith("__STANDALONE_");
}

/**
 * Get the mode identifier from a standalone command result.
 * e.g. "__STANDALONE_WRITE__" → "WRITE"
 */
export function getStandaloneMode(resultOutput: string): string {
  const match = resultOutput.match(/^__STANDALONE_(\w+)__$/);
  return match ? match[1] : "DEFAULT";
}

/**
 * Get all registered commands (for help display).
 */
export function listCommands(): ReadonlyArray<SlashCommand> {
  return ALL_COMMANDS;
}

/**
 * Generate formatted help text for all commands.
 */
export function generateHelpText(): string {
  const lines: string[] = [
    "",
    "\x1b[1m\x1b[35m╔══════════════════════════════════════════════════════════╗\x1b[0m",
    "\x1b[1m\x1b[35m║              VENOM — Command Reference                  ║\x1b[0m",
    "\x1b[1m\x1b[35m╠══════════════════════════════════════════════════════════╣\x1b[0m",
    "\x1b[35m║\x1b[0m                                                          \x1b[35m║\x1b[0m",
  ];

  for (const cmd of ALL_COMMANDS) {
    const name = cmd.name.padEnd(10);
    const desc = cmd.description.slice(0, 44).padEnd(44);
    lines.push(`\x1b[35m║\x1b[0m  \x1b[36m${name}\x1b[0m ${desc} \x1b[35m║\x1b[0m`);
  }

  lines.push(
    "\x1b[35m║\x1b[0m                                                          \x1b[35m║\x1b[0m",
    "\x1b[35m║\x1b[0m  \x1b[36m/stats\x1b[0m     Show session statistics                       \x1b[35m║\x1b[0m",
    "\x1b[35m║\x1b[0m  \x1b[36m/clear\x1b[0m     Clear conversation history                    \x1b[35m║\x1b[0m",
    "\x1b[35m║\x1b[0m  \x1b[36m/help\x1b[0m      Show this help                                \x1b[35m║\x1b[0m",
    "\x1b[35m║\x1b[0m  \x1b[36m/exit\x1b[0m      Exit VENOM                                    \x1b[35m║\x1b[0m",
    "\x1b[35m║\x1b[0m                                                          \x1b[35m║\x1b[0m",
    "\x1b[35m║\x1b[0m  \x1b[90mOr type any question for standalone mode.\x1b[0m                \x1b[35m║\x1b[0m",
    "\x1b[35m║\x1b[0m  \x1b[90mUse @filename to include file context.\x1b[0m                   \x1b[35m║\x1b[0m",
    "\x1b[35m║\x1b[0m                                                          \x1b[35m║\x1b[0m",
    "\x1b[1m\x1b[35m╚══════════════════════════════════════════════════════════╝\x1b[0m",
    "",
  );

  return lines.join("\n");
}

// Re-export individual system prompts for direct use
export { CODE_SYSTEM_PROMPT } from "./code.js";
export { WRITE_SYSTEM_PROMPT } from "./write.js";
export { SHELL_SYSTEM_PROMPT } from "./shell.js";
export { BUILD_SYSTEM_PROMPT } from "./build.js";
export { VIBE_SYSTEM_PROMPT } from "./vibe.js";
export { DEBUG_SYSTEM_PROMPT } from "./debug.js";
export { PLAN_SYSTEM_PROMPT } from "./plan.js";
export { ASK_SYSTEM_PROMPT } from "./ask.js";

export type { SlashCommand, CommandContext, CommandResult } from "./types.js";
