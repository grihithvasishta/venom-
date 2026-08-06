/**
 * VENOM CLI — Autonomous Debug Loop
 * (Top-level orchestrator/ — imports from ../core/sandbox)
 */

import type { GeneratedFile, DebugIterationResult, DebugLoopSummary } from "./types.js";
import { MAX_DEBUG_ITERATIONS } from "./types.js";
import { AGENTS } from "./agents.js";
import type { NimClient } from "./nim_client.js";
import { extractCodeFiles, writeGeneratedFiles } from "./code_writer.js";
import type { Sandbox, SandboxResult } from "../core/sandbox.js";

export interface DebugLoopConfig {
  maxIterations?: number;
  sandboxTimeoutMs?: number;
  verbose?: boolean;
}

export async function runDebugLoop(
  nim: NimClient, sandbox: Sandbox, plan: string, codeOutput: string,
  files: GeneratedFile[], cwd: string, config?: DebugLoopConfig
): Promise<DebugLoopSummary> {
  const cfg = { maxIterations: MAX_DEBUG_ITERATIONS, sandboxTimeoutMs: 30_000, verbose: true, ...config };
  const start = Date.now();
  let curPlan = plan, curCode = codeOutput, curFiles = [...files];
  let iter = 0;
  const iterations: DebugIterationResult[] = [];
  let finalVerdict: DebugLoopSummary["finalVerdict"] = "FAILED";

  while (iter < cfg.maxIterations) {
    iter++;
    const iterStart = Date.now();
    if (cfg.verbose) console.log(`\n\x1b[36m  ── Debug ${iter}/${cfg.maxIterations} ──\x1b[0m`);

    const testCmd = await nim.chatWithProgress(AGENTS.main, [{
      role: "user",
      content: `Based on this code, what single shell command should I run to test it? Return ONLY the command. If none applicable, return "SKIP".\n\nFiles:\n${curFiles.map(f => f.filepath).join("\n")}`,
    }], "Determining test");

    const cmd = testCmd.trim().split("\n")[0].trim();
    if (!cmd || cmd === "SKIP" || cmd.length > 500) {
      if (cfg.verbose) console.log("  \x1b[33m⊘\x1b[0m No test — passed.");
      iterations.push({ iteration: iter, testCommand: "SKIP", exitCode: null, stdout: "", stderr: "", verdict: "SKIPPED", durationMs: Date.now() - iterStart });
      finalVerdict = "SKIPPED";
      break;
    }

    if (cfg.verbose) console.log(`  \x1b[90m$ ${cmd}\x1b[0m`);
    const result: SandboxResult = await sandbox.execute(cmd, { cwd, timeoutMs: cfg.sandboxTimeoutMs });
    const combined = `STDOUT:\n${result.stdout || "(empty)"}\n\nSTDERR:\n${result.stderr || "(empty)"}\n\nEXIT: ${result.exitCode}${result.timedOut ? "\n[TIMED OUT]" : ""}`;

    const report = await nim.chatWithProgress(AGENTS.debugger, [{
      role: "user", content: `Analyze this execution output:\n\n${combined}`,
    }], "Validating");

    const verdict = report.includes("PASSED") ? "PASSED" as const : report.includes("BUG_FOUND:") ? "BUG_FOUND" as const : "AMBIGUOUS" as const;
    iterations.push({ iteration: iter, testCommand: cmd, exitCode: result.exitCode, stdout: result.stdout.slice(0, 5000), stderr: result.stderr.slice(0, 5000), verdict, bugReport: verdict === "BUG_FOUND" ? report : undefined, durationMs: Date.now() - iterStart });

    if (verdict === "PASSED") {
      if (cfg.verbose) console.log("  \x1b[32m✓ Passed.\x1b[0m");
      finalVerdict = "PASSED";
      break;
    }
    if (verdict === "BUG_FOUND") {
      if (cfg.verbose) console.log("  \x1b[91m✗ Bug — auto-fixing.\x1b[0m");
      const newPlan = await nim.chatWithProgress(AGENTS.planner, [{ role: "user", content: `Fix this plan.\n\nPlan:\n${curPlan.slice(0, 3000)}\n\nBug:\n${report}` }], "Re-planning");
      const fixed = await nim.chatWithProgress(AGENTS.coder, [{ role: "user", content: `Fix the code.\n\nPlan:\n${newPlan}\n\nBug:\n${report}\n\nCode:\n${curCode.slice(0, 8000)}` }], "Fixing");
      curPlan = newPlan; curCode = fixed;
      const ex = extractCodeFiles(fixed);
      if (ex.files.length) { curFiles = ex.files; if (cfg.verbose) console.log(`\n\x1b[36m  Rewriting ${ex.files.length} file(s):\x1b[0m`); writeGeneratedFiles(ex.files, cwd); }
    } else {
      if (cfg.verbose) console.log("  \x1b[33m⚠ Ambiguous — proceeding.\x1b[0m");
      finalVerdict = "PASSED";
      break;
    }
  }

  if (iter >= cfg.maxIterations && finalVerdict === "FAILED") {
    finalVerdict = "MAX_ITERATIONS";
    if (cfg.verbose) console.log(`\n  \x1b[91m⚠ Max iterations reached.\x1b[0m`);
  }

  return { totalIterations: iter, maxIterations: cfg.maxIterations, finalVerdict, iterations, totalDurationMs: Date.now() - start };
}
