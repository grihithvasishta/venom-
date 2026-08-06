/**
 * VENOM CLI — File Context Extractor
 * Resolves @file/@dir references from user input.
 * (Moved to top-level orchestrator/)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileContextResult } from "./types.js";

const MAX_FILE_SIZE = 512 * 1024;
const MAX_DIR_ENTRIES = 300;
const MAX_CONTEXT_CHARS = 100_000;

const BINARY_EXTS = new Set([
  ".png",".jpg",".jpeg",".gif",".bmp",".ico",".webp",".svg",
  ".mp3",".mp4",".avi",".mov",".wav",".zip",".tar",".gz",".7z",".rar",
  ".exe",".dll",".so",".dylib",".node",".woff",".woff2",".ttf",
  ".pdf",".doc",".docx",".pyc",".class",".o",".obj",
]);

const SKIP_DIRS = new Set([
  "node_modules",".git","__pycache__",".next",".venv",
  "dist","build",".cache","venv","env",".idea",".vscode","coverage",
]);

export function extractFileReferences(input: string, cwd: string = process.cwd()): FileContextResult {
  const atPattern = /@([\w.\/\\:~-]+)/g;
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = atPattern.exec(input)) !== null) refs.push(m[1]);

  const unique = [...new Set(refs)];
  let context = "", total = 0;
  const resolvedPaths: string[] = [], failedPaths: string[] = [];

  for (const ref of unique) {
    if (total >= MAX_CONTEXT_CHARS) { context += "\n[CONTEXT TRUNCATED]\n"; break; }
    const abs = resolvePath(ref, cwd);
    try {
      if (!fs.existsSync(abs)) { failedPaths.push(ref); continue; }
      const stat = fs.statSync(abs);
      let block = "";
      if (stat.isFile()) {
        block = readFile(ref, abs, stat.size);
      } else if (stat.isDirectory()) {
        block = readDir(ref, abs);
      }
      context += block;
      total += block.length;
      resolvedPaths.push(abs);
    } catch { failedPaths.push(ref); }
  }

  const cleaned = input.replace(atPattern, "").replace(/\s{2,}/g, " ").trim();
  return { cleaned, context, resolvedPaths, failedPaths };
}

function resolvePath(ref: string, cwd: string): string {
  if (ref.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.resolve(home, ref.slice(1));
  }
  return path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
}

function readFile(display: string, abs: string, size: number): string {
  const ext = path.extname(abs).toLowerCase();
  if (BINARY_EXTS.has(ext)) return `\n--- FILE: ${display} [BINARY, ${fmtSize(size)}] ---\n`;
  try {
    let content: string;
    if (size > MAX_FILE_SIZE) {
      const buf = Buffer.alloc(MAX_FILE_SIZE);
      const fd = fs.openSync(abs, "r");
      const n = fs.readSync(fd, buf, 0, MAX_FILE_SIZE, 0);
      fs.closeSync(fd);
      content = buf.toString("utf-8", 0, n) + "\n[TRUNCATED]";
    } else {
      content = fs.readFileSync(abs, "utf-8");
    }
    const lines = content.split("\n").length;
    return `\n--- FILE: ${display} (${lines} lines) ---\n${content}\n--- END FILE ---\n`;
  } catch (e) {
    return `\n--- FILE: ${display} [READ ERROR] ---\n`;
  }
}

function readDir(display: string, abs: string): string {
  try {
    const entries: string[] = [];
    walk(abs, abs, entries, 0);
    const shown = entries.slice(0, MAX_DIR_ENTRIES);
    let block = `\n--- DIR: ${display} (${entries.length} entries) ---\n`;
    block += shown.join("\n");
    if (entries.length > MAX_DIR_ENTRIES) block += `\n... +${entries.length - MAX_DIR_ENTRIES} more`;
    block += `\n--- END DIR ---\n`;
    return block;
  } catch { return `\n--- DIR: ${display} [READ ERROR] ---\n`; }
}

function walk(root: string, cur: string, entries: string[], depth: number): void {
  if (depth > 10 || entries.length >= MAX_DIR_ENTRIES * 2) return;
  let items: fs.Dirent[];
  try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
  items.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
  for (const item of items) {
    if (item.name.startsWith(".") && item.isDirectory()) continue;
    const indent = "  ".repeat(depth);
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) { entries.push(`${indent}${item.name}/ [skipped]`); continue; }
      entries.push(`${indent}${item.name}/`);
      walk(root, path.join(cur, item.name), entries, depth + 1);
    } else {
      entries.push(`${indent}${item.name}`);
    }
  }
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1048576).toFixed(1)}MB`;
}
