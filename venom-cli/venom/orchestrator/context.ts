/**
 * VENOM CLI — File Context Extractor
 *
 * Resolves `@filename` and `@directory` references in user input,
 * reads their content, and produces an enriched context string for
 * injection into agent prompts. Supports recursive directory trees,
 * binary file detection, and size-limited content inclusion.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileContextResult } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size to inline (500KB). Larger files get truncated. */
const MAX_FILE_SIZE_BYTES = 512 * 1024;

/** Maximum directory entries to list. */
const MAX_DIR_ENTRIES = 300;

/** Maximum total context size in characters. */
const MAX_TOTAL_CONTEXT_CHARS = 100_000;

/** File extensions considered binary (skip content, only show path). */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac", ".ogg",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".node",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".pyc", ".pyo", ".class", ".o", ".obj",
]);

// ---------------------------------------------------------------------------
// Core Extraction Logic
// ---------------------------------------------------------------------------

/**
 * Extract all `@path` references from user input, resolve them against
 * the working directory, read their contents, and return an enriched
 * context block alongside the cleaned (reference-free) user input.
 */
export function extractFileReferences(
  input: string,
  cwd: string = process.cwd()
): FileContextResult {
  const atPattern = /@([\w.\/\\:~-]+)/g;
  const refs: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = atPattern.exec(input)) !== null) {
    refs.push(match[1]);
  }

  // Deduplicate
  const uniqueRefs = [...new Set(refs)];

  let context = "";
  const resolvedPaths: string[] = [];
  const failedPaths: string[] = [];
  let totalChars = 0;

  for (const ref of uniqueRefs) {
    if (totalChars >= MAX_TOTAL_CONTEXT_CHARS) {
      context += `\n[CONTEXT TRUNCATED — limit reached (${MAX_TOTAL_CONTEXT_CHARS} chars)]\n`;
      break;
    }

    const resolved = resolvePath(ref, cwd);

    try {
      if (!fs.existsSync(resolved)) {
        failedPaths.push(ref);
        continue;
      }

      const stat = fs.statSync(resolved);

      if (stat.isFile()) {
        const block = readFileContext(ref, resolved, stat.size);
        context += block;
        totalChars += block.length;
        resolvedPaths.push(resolved);
      } else if (stat.isDirectory()) {
        const block = readDirectoryContext(ref, resolved);
        context += block;
        totalChars += block.length;
        resolvedPaths.push(resolved);
      }
    } catch {
      failedPaths.push(ref);
    }
  }

  const cleaned = input.replace(atPattern, "").replace(/\s{2,}/g, " ").trim();

  return { cleaned, context, resolvedPaths, failedPaths };
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a user-provided path reference to an absolute path.
 * Handles `~` home directory expansion and relative paths.
 */
function resolvePath(ref: string, cwd: string): string {
  // Expand ~ to home directory
  if (ref.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.resolve(home, ref.slice(1));
  }

  // Absolute paths pass through
  if (path.isAbsolute(ref)) {
    return ref;
  }

  // Relative to cwd
  return path.resolve(cwd, ref);
}

// ---------------------------------------------------------------------------
// File Reader
// ---------------------------------------------------------------------------

/**
 * Read a single file's content and format it as a context block.
 * Handles binary detection and size truncation.
 */
function readFileContext(
  displayPath: string,
  absolutePath: string,
  fileSize: number
): string {
  const ext = path.extname(absolutePath).toLowerCase();

  // Binary files: just note their existence
  if (BINARY_EXTENSIONS.has(ext)) {
    return `\n--- FILE: ${displayPath} [BINARY, ${formatSize(fileSize)}] ---\n`;
  }

  try {
    let content: string;

    if (fileSize > MAX_FILE_SIZE_BYTES) {
      // Read only the first chunk for large files
      const buffer = Buffer.alloc(MAX_FILE_SIZE_BYTES);
      const fd = fs.openSync(absolutePath, "r");
      const bytesRead = fs.readSync(fd, buffer, 0, MAX_FILE_SIZE_BYTES, 0);
      fs.closeSync(fd);
      content =
        buffer.toString("utf-8", 0, bytesRead) +
        `\n\n[TRUNCATED — file is ${formatSize(fileSize)}, showing first ${formatSize(MAX_FILE_SIZE_BYTES)}]`;
    } else {
      content = fs.readFileSync(absolutePath, "utf-8");
    }

    // Detect if content looks binary despite extension
    if (hasBinaryContent(content)) {
      return `\n--- FILE: ${displayPath} [BINARY CONTENT, ${formatSize(fileSize)}] ---\n`;
    }

    const lineCount = content.split("\n").length;
    return `\n--- FILE: ${displayPath} (${lineCount} lines, ${formatSize(fileSize)}) ---\n${content}\n--- END FILE ---\n`;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return `\n--- FILE: ${displayPath} [READ ERROR: ${errMsg}] ---\n`;
  }
}

// ---------------------------------------------------------------------------
// Directory Reader
// ---------------------------------------------------------------------------

/**
 * Read a directory tree and format it as a context block.
 * Lists entries recursively up to MAX_DIR_ENTRIES.
 */
function readDirectoryContext(
  displayPath: string,
  absolutePath: string
): string {
  try {
    const entries: string[] = [];
    walkDirectory(absolutePath, absolutePath, entries, 0);

    const truncated = entries.length > MAX_DIR_ENTRIES;
    const shown = entries.slice(0, MAX_DIR_ENTRIES);

    let block = `\n--- DIR: ${displayPath} (${entries.length} entries) ---\n`;
    block += shown.join("\n");
    if (truncated) {
      block += `\n... and ${entries.length - MAX_DIR_ENTRIES} more entries`;
    }
    block += `\n--- END DIR ---\n`;

    return block;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return `\n--- DIR: ${displayPath} [READ ERROR: ${errMsg}] ---\n`;
  }
}

/**
 * Recursively walk a directory, collecting relative paths.
 * Skips hidden directories, node_modules, and common build output.
 */
function walkDirectory(
  root: string,
  current: string,
  entries: string[],
  depth: number
): void {
  if (depth > 10 || entries.length >= MAX_DIR_ENTRIES * 2) return;

  const SKIP_DIRS = new Set([
    "node_modules", ".git", "__pycache__", ".next", ".venv",
    "dist", "build", ".cache", ".tox", "venv", "env",
    ".idea", ".vscode", "coverage", ".nyc_output",
  ]);

  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  // Sort: directories first, then files
  items.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const item of items) {
    if (item.name.startsWith(".") && item.isDirectory()) continue;

    const rel = path.relative(root, path.join(current, item.name));
    const indent = "  ".repeat(depth);

    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) {
        entries.push(`${indent}${item.name}/ [skipped]`);
        continue;
      }
      entries.push(`${indent}${item.name}/`);
      walkDirectory(root, path.join(current, item.name), entries, depth + 1);
    } else {
      const size = safeFileSize(path.join(current, item.name));
      entries.push(`${indent}${item.name} (${formatSize(size)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function safeFileSize(filepath: string): number {
  try {
    return fs.statSync(filepath).size;
  } catch {
    return 0;
  }
}

/** Heuristic: detect binary content by checking for null bytes. */
function hasBinaryContent(content: string): boolean {
  const sample = content.slice(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) return true;
  }
  return false;
}
