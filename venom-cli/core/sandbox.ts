/**
 * VENOM CLI — Sandbox (Enhanced)
 *
 * Guarded subprocess execution integrated with the Safety module.
 * ALL shell commands pass through validateCommand() before execution.
 * Supports buffered and streaming modes, timeout enforcement,
 * output size limits, and output sanitization.
 */

import { spawn, ChildProcess } from "node:child_process";
import * as os from "node:os";
import {
  validateCommand,
  formatVerdict,
  sanitizeOutput,
  ThreatLevel,
  type SecurityVerdict,
} from "./safety.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  shell?: string;
  /** If true, skip safety validation (DANGEROUS — only for internal use). */
  bypassSafety?: boolean;
  /** If true, sanitize output to redact secrets. */
  sanitize?: boolean;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  securityVerdict: SecurityVerdict;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export class Sandbox {
  private defaultShell: string;

  constructor() {
    this.defaultShell = os.platform() === "win32" ? "cmd.exe" : "/bin/sh";
  }

  /**
   * Execute a shell command with full safety validation.
   * Returns BLOCKED result if command fails security checks.
   */
  async execute(command: string, options: SandboxOptions = {}): Promise<SandboxResult> {
    const {
      cwd = process.cwd(),
      timeoutMs = 30_000,
      env = {},
      maxOutputBytes = 5 * 1024 * 1024,
      shell = this.defaultShell,
      bypassSafety = false,
      sanitize = true,
    } = options;

    // Security gate
    const verdict = bypassSafety
      ? { level: ThreatLevel.SAFE, reason: "Bypassed" } as SecurityVerdict
      : validateCommand(command);

    if (verdict.level === ThreatLevel.BLOCKED) {
      return {
        stdout: "",
        stderr: `[VENOM SAFETY] ${formatVerdict(verdict)}`,
        exitCode: 126,
        signal: null,
        timedOut: false,
        durationMs: 0,
        securityVerdict: verdict,
      };
    }

    // Execute
    return new Promise<SandboxResult>((resolve) => {
      const startTime = Date.now();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let timedOut = false;
      let finished = false;

      const args = os.platform() === "win32" ? ["/c", command] : ["-c", command];

      const child: ChildProcess = spawn(shell, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        if (!finished) { timedOut = true; child.kill("SIGKILL"); }
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutSize < maxOutputBytes) { stdoutChunks.push(chunk); stdoutSize += chunk.length; }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrSize < maxOutputBytes) { stderrChunks.push(chunk); stderrSize += chunk.length; }
      });

      child.on("close", (exitCode, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        let stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        let stderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (stdoutSize >= maxOutputBytes) stdout += "\n[TRUNCATED]";
        if (stderrSize >= maxOutputBytes) stderr += "\n[TRUNCATED]";

        if (sanitize) {
          stdout = sanitizeOutput(stdout);
          stderr = sanitizeOutput(stderr);
        }

        resolve({
          stdout, stderr,
          exitCode,
          signal: signal || null,
          timedOut,
          durationMs: Date.now() - startTime,
          securityVerdict: verdict,
        });
      });

      child.on("error", (err: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({
          stdout: "",
          stderr: `[VENOM SANDBOX] Spawn error: ${err.message}`,
          exitCode: 127,
          signal: null,
          timedOut: false,
          durationMs: Date.now() - startTime,
          securityVerdict: verdict,
        });
      });
    });
  }

  /**
   * Execute with real-time streaming output via callback.
   */
  async executeStreaming(
    command: string,
    onLine: (stream: "stdout" | "stderr", line: string) => void,
    options: SandboxOptions = {}
  ): Promise<SandboxResult> {
    const {
      cwd = process.cwd(),
      timeoutMs = 60_000,
      env = {},
      shell = this.defaultShell,
      bypassSafety = false,
      sanitize = true,
    } = options;

    const verdict = bypassSafety
      ? { level: ThreatLevel.SAFE, reason: "Bypassed" } as SecurityVerdict
      : validateCommand(command);

    if (verdict.level === ThreatLevel.BLOCKED) {
      return {
        stdout: "", stderr: `[VENOM SAFETY] ${formatVerdict(verdict)}`,
        exitCode: 126, signal: null, timedOut: false, durationMs: 0,
        securityVerdict: verdict,
      };
    }

    return new Promise<SandboxResult>((resolve) => {
      const startTime = Date.now();
      let allStdout = "", allStderr = "";
      let timedOut = false, finished = false;

      const args = os.platform() === "win32" ? ["/c", command] : ["-c", command];
      const child = spawn(shell, args, {
        cwd, env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });

      const timer = setTimeout(() => {
        if (!finished) { timedOut = true; child.kill("SIGKILL"); }
      }, timeoutMs);

      let stdoutBuf = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        allStdout += text;
        stdoutBuf += text;
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() || "";
        for (const line of lines) onLine("stdout", sanitize ? sanitizeOutput(line) : line);
      });

      let stderrBuf = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        allStderr += text;
        stderrBuf += text;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() || "";
        for (const line of lines) onLine("stderr", sanitize ? sanitizeOutput(line) : line);
      });

      child.on("close", (exitCode, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (stdoutBuf) onLine("stdout", stdoutBuf);
        if (stderrBuf) onLine("stderr", stderrBuf);
        resolve({
          stdout: sanitize ? sanitizeOutput(allStdout) : allStdout,
          stderr: sanitize ? sanitizeOutput(allStderr) : allStderr,
          exitCode, signal: signal || null, timedOut,
          durationMs: Date.now() - startTime, securityVerdict: verdict,
        });
      });

      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({
          stdout: allStdout,
          stderr: `[VENOM SANDBOX] Spawn error: ${err.message}`,
          exitCode: 127, signal: null, timedOut: false,
          durationMs: Date.now() - startTime, securityVerdict: verdict,
        });
      });
    });
  }

  /** Get the security verdict for a command without executing it. */
  dryRun(command: string): SecurityVerdict {
    return validateCommand(command);
  }
}
