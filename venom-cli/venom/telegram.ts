/**
 * VENOM CLI — Telegram Bot Gateway (Enhanced)
 *
 * Listens for incoming Telegram messages via long polling and routes them
 * through the same multi-agent pipeline used by the CLI interface.
 * Sub-agents never communicate with Telegram directly — all output is
 * funneled through the Main Overview Agent.
 *
 * Features:
 * - Inline keyboard approval gate (Approve / Revise)
 * - Live-updating status messages (edit-in-place)
 * - File delivery via sendDocument (multipart/form-data)
 * - Context file uploads (user sends documents for @-style context)
 * - Uses native Node.js https — zero external dependencies.
 */

import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
}

interface TelegramFrom {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramFrom;
  text?: string;
  document?: TelegramDocument;
  caption?: string;
  date: number;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramFrom;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse {
  ok: boolean;
  result: TelegramUpdate[] | TelegramMessage | TelegramFileResponse | object;
  description?: string;
}

interface TelegramFileResponse {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface NimChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface NimChatResponse {
  choices: Array<{ message: { content: string } }>;
}

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** Tracks a pending approval for a chat. */
interface PendingApproval {
  chatId: number;
  plan: string;
  optimizedPrompt: string;
  statusMessageId: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEGRAM_API_BASE = "https://api.telegram.org";
const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const POLL_TIMEOUT_SECS = 30;

// Agent model configs (mirroring orchestrator.ts)
const MAIN_MODEL = "deepseek-ai/deepseek-v4-flash";
const PLANNER_MODEL = "moonshotai/kimi-k1.5";
const CODER_MODEL = "qwen/qwen2.5-coder-32b-instruct";
const DEBUGGER_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";

const MAIN_SYSTEM_PROMPT = `You are the VENOM Main Overview Agent operating through Telegram. You are the manager and traffic router for a multi-agent coding system. Respond concisely and format output for Telegram (use Markdown). For simple queries, answer directly. For coding tasks (prefixed with /code, /vibe, or /build), coordinate the Planning, Coding, and Debugger agents internally and present clean results.`;

// Approval timeout: 10 minutes
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP Helpers (native Node.js — no external dependencies)
// ---------------------------------------------------------------------------

function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string | Buffer
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          data: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error("Request timeout"));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Build a multipart/form-data body for file uploads.
 * Returns { body, contentType }.
 */
function buildMultipart(
  fields: Record<string, string>,
  file: { fieldName: string; fileName: string; content: Buffer; mimeType: string }
): { body: Buffer; contentType: string } {
  const boundary = `----VenomBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];

  // Text fields
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    );
  }

  // File field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`
    )
  );
  parts.push(file.content);
  parts.push(Buffer.from("\r\n"));

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------------------------------------------------------------------------
// Telegram API Client (Enhanced)
// ---------------------------------------------------------------------------

class TelegramClient {
  private baseUrl: string;
  private token: string;

  constructor(token: string) {
    this.token = token;
    this.baseUrl = `${TELEGRAM_API_BASE}/bot${token}`;
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const url = `${this.baseUrl}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SECS}&allowed_updates=["message","callback_query"]`;

    try {
      const { data } = await httpsRequest(url, { method: "GET" });
      const response: TelegramApiResponse = JSON.parse(data);
      if (!response.ok) {
        console.error(`[TELEGRAM] API error: ${response.description}`);
        return [];
      }
      return response.result as TelegramUpdate[];
    } catch (err) {
      console.error(`[TELEGRAM] getUpdates error: ${err}`);
      return [];
    }
  }

  /** Send a text message. Returns the sent message_id. */
  async sendMessage(chatId: number, text: string): Promise<number> {
    const url = `${this.baseUrl}/sendMessage`;

    // Truncate to Telegram's 4096 char limit
    const truncated =
      text.length > 4000
        ? text.slice(0, 3990) + "\n\n[truncated]"
        : text;

    const body = JSON.stringify({
      chat_id: chatId,
      text: truncated,
      parse_mode: "Markdown",
    });

    try {
      const { data } = await httpsRequest(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, body);
      const parsed: TelegramApiResponse = JSON.parse(data);
      if (parsed.ok && parsed.result && typeof parsed.result === "object" && "message_id" in parsed.result) {
        return (parsed.result as TelegramMessage).message_id;
      }
      return 0;
    } catch (err) {
      console.error(`[TELEGRAM] sendMessage error: ${err}`);
      return 0;
    }
  }

  /** Send a message with an inline keyboard. Returns the sent message_id. */
  async sendWithKeyboard(
    chatId: number,
    text: string,
    buttons: InlineKeyboardButton[][]
  ): Promise<number> {
    const url = `${this.baseUrl}/sendMessage`;

    const truncated =
      text.length > 4000
        ? text.slice(0, 3990) + "\n\n[truncated]"
        : text;

    const body = JSON.stringify({
      chat_id: chatId,
      text: truncated,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    });

    try {
      const { data } = await httpsRequest(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, body);
      const parsed: TelegramApiResponse = JSON.parse(data);
      if (parsed.ok && parsed.result && typeof parsed.result === "object" && "message_id" in parsed.result) {
        return (parsed.result as TelegramMessage).message_id;
      }
      return 0;
    } catch (err) {
      console.error(`[TELEGRAM] sendWithKeyboard error: ${err}`);
      return 0;
    }
  }

  /** Edit an existing message's text (live status updates). */
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    const url = `${this.baseUrl}/editMessageText`;

    const truncated =
      text.length > 4000
        ? text.slice(0, 3990) + "\n\n[truncated]"
        : text;

    const body = JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: truncated,
      parse_mode: "Markdown",
    });

    try {
      await httpsRequest(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, body);
    } catch (err) {
      console.error(`[TELEGRAM] editMessageText error: ${err}`);
    }
  }

  /** Answer a callback query (acknowledge a button tap). */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const url = `${this.baseUrl}/answerCallbackQuery`;
    const body = JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || "",
    });

    try {
      await httpsRequest(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, body);
    } catch {
      // Non-critical
    }
  }

  async sendTypingAction(chatId: number): Promise<void> {
    const url = `${this.baseUrl}/sendChatAction`;
    const body = JSON.stringify({
      chat_id: chatId,
      action: "typing",
    });

    try {
      await httpsRequest(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, body);
    } catch {
      // Non-critical — ignore errors
    }
  }

  /**
   * Send a document (file) to the chat.
   * The file content is sent as a multipart/form-data upload.
   */
  async sendDocument(
    chatId: number,
    fileName: string,
    content: Buffer,
    caption?: string
  ): Promise<void> {
    const fields: Record<string, string> = {
      chat_id: String(chatId),
    };
    if (caption) {
      fields.caption = caption.length > 1000 ? caption.slice(0, 990) + "…" : caption;
      fields.parse_mode = "Markdown";
    }

    const mimeType = guessMimeType(fileName);
    const { body, contentType } = buildMultipart(fields, {
      fieldName: "document",
      fileName,
      content,
      mimeType,
    });

    const url = `${this.baseUrl}/sendDocument`;
    const parsed = new URL(url);

    try {
      await httpsRequest(url, {
        method: "POST",
        hostname: parsed.hostname,
        path: parsed.pathname,
        headers: {
          "Content-Type": contentType,
          "Content-Length": body.length,
        },
      }, body);
    } catch (err) {
      console.error(`[TELEGRAM] sendDocument error: ${err}`);
    }
  }

  /**
   * Get file metadata from Telegram (to download user-uploaded files).
   */
  async getFileInfo(fileId: string): Promise<TelegramFileResponse | null> {
    try {
      const { data } = await httpsRequest(
        `${this.baseUrl}/getFile?file_id=${fileId}`,
        { method: "GET" }
      );
      const parsed: TelegramApiResponse = JSON.parse(data);
      if (parsed.ok && parsed.result) {
        return parsed.result as TelegramFileResponse;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Download a file from Telegram servers given a file_path.
   */
  async downloadFile(filePath: string): Promise<Buffer | null> {
    const url = `${TELEGRAM_API_BASE}/file/bot${this.token}/${filePath}`;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        https.get(url, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }).on("error", reject);
      });
    } catch {
      return null;
    }
  }
}

/** Best-effort MIME type from file extension. */
function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "text/x-typescript",
    ".js": "application/javascript",
    ".py": "text/x-python",
    ".json": "application/json",
    ".html": "text/html",
    ".css": "text/css",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "application/toml",
    ".sh": "text/x-shellscript",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
  };
  return map[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// NIM API Client (Telegram variant — simplified)
// ---------------------------------------------------------------------------

class NimTelegramClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(
    model: string,
    systemPrompt: string,
    messages: NimChatMessage[],
    temperature: number = 0.3,
    maxTokens: number = 4096
  ): Promise<string> {
    const fullMessages: NimChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const body = JSON.stringify({
      model,
      messages: fullMessages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    });

    const parsedUrl = new URL(NIM_BASE_URL);

    const { status, data } = await httpsRequest(NIM_BASE_URL, {
      method: "POST",
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, body);

    if (status !== 200) {
      throw new Error(`NIM API error [${status}]: ${data.slice(0, 300)}`);
    }

    const response: NimChatResponse = JSON.parse(data);
    if (!response.choices || response.choices.length === 0) {
      throw new Error("NIM API returned empty choices.");
    }

    return response.choices[0].message.content;
  }
}

// ---------------------------------------------------------------------------
// Telegram Pipeline Handler (Enhanced)
// ---------------------------------------------------------------------------

const AGENTIC_PREFIXES = ["/code", "/vibe", "/build"];

/** Status line icons for each pipeline phase. */
const STATUS_ICONS: Record<string, { pending: string; done: string }> = {
  optimize: { pending: "⏳", done: "✅" },
  plan: { pending: "⏳", done: "✅" },
  approve: { pending: "⏳", done: "✅" },
  generate: { pending: "⏳", done: "✅" },
  validate: { pending: "⏳", done: "✅" },
};

/** Build a live-updating status message string. */
function buildStatusText(
  phases: Array<{ key: string; label: string; status: "pending" | "active" | "done" | "skipped" }>
): string {
  const lines = phases.map((p) => {
    const icons = STATUS_ICONS[p.key];
    if (!icons) return `  ${p.label}`;
    switch (p.status) {
      case "done":
        return `${icons.done} ${p.label}`;
      case "active":
        return `⟐ *${p.label}...*`;
      case "skipped":
        return `⏭ ~${p.label}~`;
      default:
        return `${icons.pending} ${p.label}`;
    }
  });
  return `🕷️ *VENOM Pipeline*\n\n${lines.join("\n")}`;
}

/**
 * Extract code blocks with filepath: prefix from LLM output.
 * Returns array of { filepath, content } objects.
 */
function extractCodeBlocks(
  raw: string
): Array<{ filepath: string; content: string }> {
  const results: Array<{ filepath: string; content: string }> = [];
  // Match ```filepath:/path/to/file or ```filepath: /path/to/file
  const pattern = /```(?:filepath:\s*)(.*?)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const filepath = match[1].trim();
    const content = match[2];
    if (filepath && content) {
      results.push({ filepath, content });
    }
  }

  // If no filepath: blocks found, try generic fenced blocks with a filename-like info string
  if (results.length === 0) {
    const fallback = /```(\S+\.(?:ts|js|py|json|html|css|yaml|yml|md|toml|rs|go|java|c|cpp|h|sh))\n([\s\S]*?)```/g;
    while ((match = fallback.exec(raw)) !== null) {
      const filepath = match[1].trim();
      const content = match[2];
      if (filepath && content) {
        results.push({ filepath, content });
      }
    }
  }

  return results;
}

class TelegramPipeline {
  private tg: TelegramClient;
  private nim: NimTelegramClient;
  private chatHistories: Map<number, NimChatMessage[]> = new Map();
  /** Context files uploaded by each chat (cleared after use). */
  private uploadedContext = new Map<number, Array<{ name: string; content: string }>>();
  /** Pending approvals keyed by chatId. */
  private pendingApprovals = new Map<number, PendingApproval>();

  constructor(tg: TelegramClient, nim: NimTelegramClient) {
    this.tg = tg;
    this.nim = nim;
  }

  async handleMessage(chatId: number, text: string): Promise<void> {
    const trimmed = text.trim();

    // ── Built-in commands ──
    if (trimmed === "/start") {
      await this.tg.sendMessage(
        chatId,
        "🕷️ *VENOM* is active.\n\n" +
          "Send a message for a quick answer.\n" +
          "Use `/code`, `/vibe`, or `/build` to trigger the full agentic pipeline.\n" +
          "Upload files for context before running a pipeline.\n\n" +
          "`/help` — show all commands"
      );
      return;
    }

    if (trimmed === "/help") {
      await this.tg.sendMessage(
        chatId,
        "*VENOM Commands:*\n" +
          "`/code <task>` — Trigger agentic coding pipeline\n" +
          "`/vibe <task>` — Alias for /code\n" +
          "`/build <task>` — Alias for /code\n" +
          "`/write <topic>` — Human-like text generation\n" +
          "`/clear` — Clear conversation history\n" +
          "`/help` — Show this help\n\n" +
          "📎 Upload files to add context before running a pipeline."
      );
      return;
    }

    if (trimmed === "/clear") {
      this.chatHistories.delete(chatId);
      this.uploadedContext.delete(chatId);
      await this.tg.sendMessage(chatId, "🗑 History and uploaded context cleared.");
      return;
    }

    await this.tg.sendTypingAction(chatId);

    try {
      // Check for agentic trigger
      let isAgentic = false;
      let body = trimmed;

      for (const prefix of AGENTIC_PREFIXES) {
        if (trimmed.startsWith(prefix)) {
          isAgentic = true;
          body = trimmed.slice(prefix.length).trim();
          break;
        }
      }

      // ── /write command ──
      if (trimmed.startsWith("/write")) {
        const wb = trimmed.slice(6).trim();
        if (!wb) {
          await this.tg.sendMessage(chatId, "Usage: `/write <topic>`");
          return;
        }
        const resp = await this.nim.chat(
          MAIN_MODEL,
          "Write as a real human. Vary sentences. Use contractions. No AI phrases. Be casual and genuine.",
          [{ role: "user", content: wb }]
        );
        await this.tg.sendMessage(chatId, resp);
        return;
      }

      if (isAgentic && body) {
        await this.handleAgenticPipeline(chatId, body);
      } else {
        await this.handleStandalone(chatId, trimmed);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.tg.sendMessage(chatId, `❌ Error: ${errMsg}`);
    }
  }

  /** Handle an uploaded document — store its content as context. */
  async handleDocument(chatId: number, doc: TelegramDocument, caption?: string): Promise<void> {
    const fileName = doc.file_name || "uploaded_file";

    // Check file size (reject > 1MB for safety)
    if (doc.file_size && doc.file_size > 1_000_000) {
      await this.tg.sendMessage(chatId, `⚠️ File \`${fileName}\` is too large (>1MB). Skipping.`);
      return;
    }

    try {
      const fileInfo = await this.tg.getFileInfo(doc.file_id);
      if (!fileInfo?.file_path) {
        await this.tg.sendMessage(chatId, `⚠️ Could not retrieve file \`${fileName}\`.`);
        return;
      }

      const content = await this.tg.downloadFile(fileInfo.file_path);
      if (!content) {
        await this.tg.sendMessage(chatId, `⚠️ Could not download file \`${fileName}\`.`);
        return;
      }

      const textContent = content.toString("utf-8");

      if (!this.uploadedContext.has(chatId)) {
        this.uploadedContext.set(chatId, []);
      }
      this.uploadedContext.get(chatId)!.push({ name: fileName, content: textContent });

      await this.tg.sendMessage(
        chatId,
        `📎 File \`${fileName}\` stored as context (${textContent.length} chars).\n` +
          `Use a pipeline command to include it.`
      );

      // If a caption is present and looks like a command, handle it
      if (caption) {
        const trimmedCaption = caption.trim();
        for (const p of AGENTIC_PREFIXES) {
          if (trimmedCaption.startsWith(p)) {
            await this.handleMessage(chatId, trimmedCaption);
            return;
          }
        }
      }
    } catch (e) {
      await this.tg.sendMessage(
        chatId,
        `❌ Failed to process file: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  /** Handle a callback query (inline keyboard button press). */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    if (!chatId || !query.data) return;

    const pending = this.pendingApprovals.get(chatId);
    if (!pending) {
      await this.tg.answerCallbackQuery(query.id, "No pending approval.");
      return;
    }

    // Check if the approval has expired
    if (Date.now() - pending.timestamp > APPROVAL_TIMEOUT_MS) {
      this.pendingApprovals.delete(chatId);
      await this.tg.answerCallbackQuery(query.id, "Approval expired.");
      await this.tg.editMessageText(chatId, pending.statusMessageId, "⏰ Approval timed out.");
      return;
    }

    if (query.data === "approve") {
      await this.tg.answerCallbackQuery(query.id, "Approved! Generating code...");
      this.pendingApprovals.delete(chatId);
      await this.executePostApproval(chatId, pending);
    } else if (query.data === "reject") {
      await this.tg.answerCallbackQuery(query.id, "Rejected. Send revised task.");
      this.pendingApprovals.delete(chatId);
      await this.tg.editMessageText(
        chatId,
        pending.statusMessageId,
        "❌ *Pipeline cancelled.* Send a revised task to try again."
      );
    }
  }

  // ── Private methods ──

  private async handleStandalone(
    chatId: number,
    text: string
  ): Promise<void> {
    // Get or create history for this chat
    if (!this.chatHistories.has(chatId)) {
      this.chatHistories.set(chatId, []);
    }
    const history = this.chatHistories.get(chatId)!;
    history.push({ role: "user", content: text });

    // Trim history
    if (history.length > 20) {
      history.splice(0, history.length - 16);
    }

    const response = await this.nim.chat(
      MAIN_MODEL,
      MAIN_SYSTEM_PROMPT,
      history
    );

    history.push({ role: "assistant", content: response });
    await this.tg.sendMessage(chatId, response);
  }

  private async handleAgenticPipeline(
    chatId: number,
    task: string
  ): Promise<void> {
    // Gather uploaded context if any
    const contextFiles = this.uploadedContext.get(chatId) || [];
    let contextBlock = "";
    if (contextFiles.length > 0) {
      contextBlock = contextFiles
        .map((f) => `--- @${f.name} ---\n${f.content}\n--- end ---`)
        .join("\n\n");
      // Clear after use
      this.uploadedContext.delete(chatId);
    }

    // Define pipeline phases
    const phases = [
      { key: "optimize", label: "Prompt Optimization", status: "active" as const },
      { key: "plan", label: "Architecture Planning", status: "pending" as const },
      { key: "approve", label: "User Approval", status: "pending" as const },
      { key: "generate", label: "Code Generation", status: "pending" as const },
      { key: "validate", label: "Validation", status: "pending" as const },
    ];

    // Send initial status message
    const statusMsgId = await this.tg.sendMessage(chatId, buildStatusText(phases));

    const updatePhase = async (
      key: string,
      status: "pending" | "active" | "done" | "skipped"
    ) => {
      const phase = phases.find((p) => p.key === key);
      if (phase) (phase as { status: string }).status = status;
      if (statusMsgId) {
        await this.tg.editMessageText(chatId, statusMsgId, buildStatusText(phases));
      }
    };

    // Step 1: Optimize prompt
    await this.tg.sendTypingAction(chatId);
    const promptInput = contextBlock
      ? `Optimize this task for the Planning Agent:\n\n${task}\n\nContext files:\n${contextBlock}`
      : `Optimize this task into a dense technical prompt for the Planning Agent:\n\n${task}`;

    const optimizedPrompt = await this.nim.chat(
      MAIN_MODEL,
      MAIN_SYSTEM_PROMPT,
      [{ role: "user", content: promptInput }]
    );
    await updatePhase("optimize", "done");

    // Step 2: Planning
    await updatePhase("plan", "active");
    await this.tg.sendTypingAction(chatId);
    const plan = await this.nim.chat(
      PLANNER_MODEL,
      "You are the VENOM Planning Agent. Produce detailed technical specifications. Never communicate with the user directly.",
      [{ role: "user", content: optimizedPrompt }],
      0.2,
      8192
    );
    await updatePhase("plan", "done");

    // Step 3: Summarize plan for user & ask approval
    await updatePhase("approve", "active");
    const summary = await this.nim.chat(
      MAIN_MODEL,
      MAIN_SYSTEM_PROMPT,
      [
        {
          role: "user",
          content: `Summarize this plan in 2-3 concise lines for Telegram:\n\n${plan.slice(0, 3000)}`,
        },
      ]
    );

    // Send plan summary with inline keyboard
    await this.tg.sendWithKeyboard(
      chatId,
      `📋 *Strategy:*\n${summary}`,
      [
        [
          { text: "✅ Approve", callback_data: "approve" },
          { text: "❌ Cancel", callback_data: "reject" },
        ],
      ]
    );

    // Store pending approval
    this.pendingApprovals.set(chatId, {
      chatId,
      plan,
      optimizedPrompt,
      statusMessageId: statusMsgId,
      timestamp: Date.now(),
    });

    // Update status to show we're waiting
    await this.tg.editMessageText(
      chatId,
      statusMsgId,
      buildStatusText(phases) + "\n\n⏳ _Waiting for your approval..._"
    );
  }

  /** Execute the pipeline after user approves. */
  private async executePostApproval(
    chatId: number,
    approval: PendingApproval
  ): Promise<void> {
    const { plan, statusMessageId } = approval;

    const phases = [
      { key: "optimize", label: "Prompt Optimization", status: "done" as const },
      { key: "plan", label: "Architecture Planning", status: "done" as const },
      { key: "approve", label: "User Approval", status: "done" as const },
      { key: "generate", label: "Code Generation", status: "active" as const },
      { key: "validate", label: "Validation", status: "pending" as const },
    ];

    const updatePhase = async (
      key: string,
      status: "pending" | "active" | "done" | "skipped"
    ) => {
      const phase = phases.find((p) => p.key === key);
      if (phase) (phase as { status: string }).status = status;
      if (statusMessageId) {
        await this.tg.editMessageText(
          chatId,
          statusMessageId,
          buildStatusText(phases)
        );
      }
    };

    try {
      // Step 4: Generate code
      await this.tg.sendTypingAction(chatId);
      const codeOutput = await this.nim.chat(
        CODER_MODEL,
        "You are the VENOM Coding Agent. Write complete production-grade code files. Output each file in a fenced block with filepath: prefix.",
        [
          {
            role: "user",
            content: `Generate complete source files:\n\n${plan}`,
          },
        ],
        0.1,
        16384
      );
      await updatePhase("generate", "done");

      // Step 5: Validate
      await updatePhase("validate", "active");
      await this.tg.sendTypingAction(chatId);
      const validation = await this.nim.chat(
        DEBUGGER_MODEL,
        "You are the VENOM Debugger Agent. Analyze code for issues. Output PASSED or BUG_FOUND: with details.",
        [
          {
            role: "user",
            content: `Static analysis — check this generated code for errors:\n\n${codeOutput.slice(0, 8000)}`,
          },
        ],
        0.1,
        4096
      );
      await updatePhase("validate", "done");

      const passed = validation.includes("PASSED");

      // Final status
      const finalStatus = passed
        ? buildStatusText(phases) + "\n\n✅ *All checks passed!*"
        : buildStatusText(phases) + "\n\n⚠️ *Issues detected — review output.*";
      await this.tg.editMessageText(chatId, statusMessageId, finalStatus);

      // Deliver code as files
      const codeBlocks = extractCodeBlocks(codeOutput);

      if (codeBlocks.length > 0) {
        // Send each extracted file as a document attachment
        for (const block of codeBlocks) {
          const fileName = path.basename(block.filepath);
          await this.tg.sendDocument(
            chatId,
            fileName,
            Buffer.from(block.content, "utf-8"),
            `\`${block.filepath}\``
          );
        }
      } else {
        // Fallback: send raw output as chunked text
        const chunks = chunkString(codeOutput, 3800);
        for (const chunk of chunks) {
          await this.tg.sendMessage(chatId, `\`\`\`\n${chunk}\n\`\`\``);
        }
      }

      // Send validation summary if issues found
      if (!passed) {
        const valChunks = chunkString(validation, 3800);
        await this.tg.sendMessage(chatId, "*Validation Report:*");
        for (const chunk of valChunks) {
          await this.tg.sendMessage(chatId, `\`\`\`\n${chunk}\n\`\`\``);
        }
      }

      await this.tg.sendMessage(chatId, "🕷️ *VENOM pipeline complete.*");
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await this.tg.editMessageText(
        chatId,
        statusMessageId,
        `❌ *Pipeline error:* ${errMsg}`
      );
      await this.tg.sendMessage(chatId, `❌ ${errMsg}`);
    }
  }
}

function chunkString(str: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < str.length) {
    chunks.push(str.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks.length > 0 ? chunks : ["(empty output)"];
}

// ---------------------------------------------------------------------------
// Main — Long Polling Loop (Enhanced with callback_query support)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const token = process.env.VENOM_TELEGRAM_TOKEN;
  const apiKey = process.env.NVIDIA_NIM_API_KEY;

  if (!token) {
    console.error("[TELEGRAM] VENOM_TELEGRAM_TOKEN not set. Exiting.");
    process.exit(1);
  }

  if (!apiKey) {
    console.warn(
      "[TELEGRAM] NVIDIA_NIM_API_KEY not set — agentic features will fail."
    );
  }

  const tg = new TelegramClient(token);
  const nim = new NimTelegramClient(apiKey || "");
  const pipeline = new TelegramPipeline(tg, nim);

  console.log("[TELEGRAM] VENOM Telegram gateway started (enhanced). Polling for updates...");

  let offset = 0;

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[TELEGRAM] Shutting down...");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("[TELEGRAM] Shutting down...");
    process.exit(0);
  });

  // Long polling loop
  while (true) {
    try {
      const updates = await tg.getUpdates(offset);

      for (const update of updates) {
        offset = update.update_id + 1;

        // ── Handle callback queries (inline keyboard button presses) ──
        if (update.callback_query) {
          pipeline
            .handleCallback(update.callback_query)
            .catch((err) =>
              console.error(`[TELEGRAM] Callback error: ${err}`)
            );
          continue;
        }

        // ── Handle document uploads ──
        if (update.message?.document) {
          const chatId = update.message.chat.id;
          pipeline
            .handleDocument(chatId, update.message.document, update.message.caption)
            .catch((err) =>
              console.error(`[TELEGRAM] Document error: ${err}`)
            );
          continue;
        }

        // ── Handle text messages ──
        if (update.message?.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text;
          const from = update.message.from?.first_name || "User";

          console.log(
            `[TELEGRAM] Message from ${from} (chat ${chatId}): ${text.slice(0, 80)}`
          );

          // Handle asynchronously to not block polling
          pipeline
            .handleMessage(chatId, text)
            .catch((err) =>
              console.error(`[TELEGRAM] Pipeline error: ${err}`)
            );
        }
      }
    } catch (err) {
      console.error(`[TELEGRAM] Polling error: ${err}`);
      // Back off on error
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch((err) => {
    console.error(`[TELEGRAM FATAL] ${err}`);
    process.exit(1);
  });
}

export { TelegramClient, TelegramPipeline };
