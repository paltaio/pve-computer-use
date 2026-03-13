#!/usr/bin/env node

/**
 * PVE Computer Use MCP Server
 *
 * MCP server that lets AI agents see and control Proxmox VE virtual machine
 * displays via VNC. Screenshot, click, type, scroll — computer use for VMs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import { PveAuthManager, loadCredentialsFromEnv } from "./pve-auth.js";
import { PveApiClient } from "./pve-api.js";
import type { VmStatus } from "./pve-api.js";
import { VncSessionManager } from "./vnc-session.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { captureScreenshot } from "./screenshot.js";
import { destroyDispatchers } from "./http.js";
import { parseKeyCombo } from "./rfb.js";

// --- State ---

let auth: PveAuthManager;
let api: PveApiClient;
let sessions: VncSessionManager;
let termSessions: TerminalSessionManager;

/** Track screen size at time of last screenshot per VM */
const lastScreenSize = new Map<number, { width: number; height: number }>();

/** Track active vmid for single-session convenience (VNC) */
let activeVmid: number | null = null;

/** Track active vmid for single-session convenience (terminal) */
let activeTermVmid: number | null = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
type TextStrategy = "auto" | "clipboard" | "vnc_keys";
const SCHTASKS_TR_MAX_CHARS = 261;
const SCHTASKS_TR_SAFE_HEADROOM = 21;
const TASK_STATUS_POLL_INTERVAL_MS = 120;
const TASK_STATUS_TIMEOUT_MS = 6000;

function resolveVmid(vmid?: number): number {
  if (vmid !== undefined) return vmid;
  if (activeVmid !== null) return activeVmid;
  throw new Error("No vmid provided and no active session. Call connect first.");
}

function resolveTermVmid(vmid?: number): number {
  if (vmid !== undefined) return vmid;
  if (activeTermVmid !== null) return activeTermVmid;
  throw new Error("No vmid provided and no active terminal session. Call serial_connect first.");
}

function formatVmTags(tags: string[]): string {
  return tags.length > 0 ? tags.join(",") : "-";
}

function matchesVmFilters(
  vm: VmStatus,
  filters: {
    vmids?: number[];
    tags?: string[];
    statuses?: string[];
    name?: string;
  },
): boolean {
  if (filters.vmids && !filters.vmids.includes(vm.vmid)) {
    return false;
  }

  if (filters.tags && !filters.tags.some((tag) => vm.tags.includes(tag))) {
    return false;
  }

  if (filters.statuses && !filters.statuses.includes(vm.status)) {
    return false;
  }

  if (filters.name) {
    const vmName = (vm.name ?? "").toLowerCase();
    if (!vmName.includes(filters.name)) {
      return false;
    }
  }

  return true;
}

/**
 * Validate coordinates against the current framebuffer.
 * Returns warnings if resolution changed since last screenshot or coords are out of bounds.
 */
function validateCoordinates(
  id: number,
  coords: { x: number; y: number }[],
  fb: { width: number; height: number },
): string[] {
  const warnings: string[] = [];
  const last = lastScreenSize.get(id);

  if (last && (last.width !== fb.width || last.height !== fb.height)) {
    warnings.push(
      `WARNING: Screen resolution changed from ${last.width}x${last.height} to ${fb.width}x${fb.height} since last screenshot. Take a new screenshot before clicking.`
    );
  }

  for (const { x, y } of coords) {
    if (x >= fb.width || y >= fb.height) {
      warnings.push(
        `WARNING: Coordinate (${x}, ${y}) is out of bounds for ${fb.width}x${fb.height} screen.`
      );
    }
  }

  return warnings;
}

function resolveTimelineVmid(stepVmid: number | undefined, timelineVmid: number | undefined): number {
  if (stepVmid !== undefined) return stepVmid;
  if (timelineVmid !== undefined) return timelineVmid;
  if (activeVmid !== null) return activeVmid;
  throw new Error("No vmid provided for timeline step and no active VNC session. Provide timeline vmid, step vmid, or call connect first.");
}

async function getOrConnectVncSession(vmid: number, node?: string) {
  const existing = sessions.getSession(vmid);
  if (existing?.connected) return existing;
  const session = await sessions.connect(vmid, node);
  activeVmid = vmid;
  return session;
}

function psSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

async function isWindowsGuest(node: string, vmid: number): Promise<boolean> {
  try {
    const result = await api.guestExec(node, vmid, "C:\\Windows\\System32\\cmd.exe", ["/c", "ver"]);
    return result.exitcode === 0;
  } catch {
    return false;
  }
}

async function getActiveWindowsUsername(node: string, vmid: number): Promise<string> {
  const result = await api.guestExec(node, vmid, "C:\\Windows\\System32\\cmd.exe", ["/c", "query user"]);
  // query user may return non-zero while still printing valid session rows.
  // Parse stdout first and only fail if no active user can be extracted.

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const raw of lines) {
    const line = raw.replace(/^>/, "").trim();
    if (!/\bActive\b/i.test(line)) continue;
    const m = line.match(/^(\S+)/);
    if (m?.[1]) return m[1];
  }

  throw new Error(`Could not find an Active desktop user (query user). exit=${result.exitcode} stderr=${result.stderr || ""}`.trim());
}

async function runInteractiveWindowsTask(node: string, vmid: number, username: string, taskName: string, taskCommand: string): Promise<void> {
  const createArgs = ["/create", "/tn", taskName, "/tr", taskCommand, "/sc", "once", "/st", "00:00", "/ru", username, "/it", "/f"];
  const create = await api.guestExec(node, vmid, "C:\\Windows\\System32\\schtasks.exe", createArgs);
  if (create.exitcode !== 0) {
    throw new Error(`schtasks create failed: ${create.stderr || create.stdout || "unknown error"}`);
  }

  const run = await api.guestExec(node, vmid, "C:\\Windows\\System32\\schtasks.exe", ["/run", "/tn", taskName]);
  if (run.exitcode !== 0) {
    await api.guestExec(node, vmid, "C:\\Windows\\System32\\schtasks.exe", ["/delete", "/tn", taskName, "/f"]);
    throw new Error(`schtasks run failed: ${run.stderr || run.stdout || "unknown error"}`);
  }
}

async function cleanupInteractiveWindowsTask(node: string, vmid: number, taskName: string): Promise<void> {
  await api.guestExec(node, vmid, "C:\\Windows\\System32\\schtasks.exe", ["/delete", "/tn", taskName, "/f"]);
}

function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

async function writeWindowsUtf16File(node: string, vmid: number, path: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, "utf16le").toString("base64");
  const command = `[IO.File]::WriteAllText('${psSingleQuoted(path)}', [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}')), [Text.Encoding]::Unicode)`;
  const result = await api.guestExec(
    node,
    vmid,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-Command", command],
  );
  if (result.exitcode !== 0) {
    throw new Error(`WriteAllText failed: ${result.stderr || "unknown error"}`);
  }
}

async function removeWindowsFile(node: string, vmid: number, path: string): Promise<void> {
  await api.guestExec(node, vmid, "C:\\Windows\\System32\\cmd.exe", ["/c", "del", "/f", "/q", path]);
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Invalid task status payload: ${trimmed || "empty output"}`);
  }
  return trimmed.slice(start, end + 1);
}

async function waitInteractiveWindowsTaskCompletion(
  node: string,
  vmid: number,
  taskName: string,
  timeoutMs: number = TASK_STATUS_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const statusCommand = [
      `$name='${psSingleQuoted(taskName)}'`,
      "$task = Get-ScheduledTask -TaskName $name -ErrorAction Stop",
      "$info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop",
      "[PSCustomObject]@{ State = [string]$task.State; LastTaskResult = [int]$info.LastTaskResult } | ConvertTo-Json -Compress",
    ].join("; ");
    const status = await api.guestExec(
      node,
      vmid,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-Command", statusCommand],
    );
    if (status.exitcode !== 0) {
      throw new Error(`task status check failed: ${status.stderr || status.stdout || "unknown error"}`);
    }

    const parsed = JSON.parse(extractJsonObject(status.stdout)) as { State?: string; LastTaskResult?: number };
    const state = parsed.State ?? "Unknown";
    const result = parsed.LastTaskResult ?? -1;

    if (state.toLowerCase() !== "running") {
      if (result === 0) return;
      // 267011 (0x41303): task has not yet run.
      if (result !== 267011) {
        throw new Error(`interactive task failed (state=${state}, result=${result})`);
      }
    }
    await sleep(TASK_STATUS_POLL_INTERVAL_MS);
  }
  throw new Error(`interactive task did not complete within ${timeoutMs}ms`);
}

async function typeTextWindowsClipboard(node: string, vmid: number, text: string): Promise<void> {
  const username = await getActiveWindowsUsername(node, vmid);
  const taskName = `McpSetClipboard_${vmid}_${Date.now()}`;
  const scriptPath = `C:\\Users\\Public\\Documents\\${taskName}.ps1`;
  const textB64 = Buffer.from(text, "utf16le").toString("base64");
  const taskScript = [
    "$ErrorActionPreference = 'Stop'",
    `$text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${textB64}'))`,
    "Set-Clipboard -Value $text",
  ].join("; ");
  const encodedScript = encodePowerShellCommand(taskScript);
  const encodedTaskCommand = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encodedScript}`;
  const fileTaskCommand = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`;

  // schtasks /tr has a strict length limit (261 chars). Use fileless mode when it fits;
  // otherwise use a short -File command and delete the temp script right away.
  const maxSafeLength = SCHTASKS_TR_MAX_CHARS - SCHTASKS_TR_SAFE_HEADROOM;
  const needsFileFallback = encodedTaskCommand.length > maxSafeLength;
  const taskCommand = needsFileFallback ? fileTaskCommand : encodedTaskCommand;

  try {
    if (needsFileFallback) {
      await writeWindowsUtf16File(node, vmid, scriptPath, taskScript);
    }
    await runInteractiveWindowsTask(node, vmid, username, taskName, taskCommand);
    await waitInteractiveWindowsTaskCompletion(node, vmid, taskName);
  } finally {
    if (needsFileFallback) {
      await removeWindowsFile(node, vmid, scriptPath);
    }
    await cleanupInteractiveWindowsTask(node, vmid, taskName);
  }
}

async function pasteClipboardViaVnc(session: ReturnType<typeof sessions.getConnectedSession>): Promise<void> {
  session.pressKey("ctrl+v");
  await sleep(120);
}

async function typeTextByStrategy(
  vmid: number,
  session: ReturnType<typeof sessions.getConnectedSession>,
  text: string,
  keyboardLayout: "en-US" | "es-ES",
  delayMs: number,
  strategy: TextStrategy,
): Promise<string> {
  const node = session.node;
  const isWindows = await isWindowsGuest(node, vmid);
  const performVnc = async () => {
    await session.typeText(text, keyboardLayout, delayMs);
    return "vnc_keys";
  };

  if (strategy === "vnc_keys") return performVnc();
  if (strategy === "clipboard") {
    if (!isWindows) return performVnc();
    await typeTextWindowsClipboard(node, vmid, text);
    await pasteClipboardViaVnc(session);
    return "clipboard";
  }

  if (!isWindows) {
    return performVnc();
  }

  // auto: clipboard -> vnc keys
  try {
    await typeTextWindowsClipboard(node, vmid, text);
    await pasteClipboardViaVnc(session);
    return "clipboard";
  } catch {
    return performVnc();
  }
}

const timelineActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("wait"),
    duration_ms: z.number().int().nonnegative().describe("Milliseconds to wait before next step"),
  }),
  z.object({
    type: z.literal("connect"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  }),
  z.object({
    type: z.literal("mouse_click"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    button: z.enum(["left", "right", "middle"]).default("left"),
  }),
  z.object({
    type: z.literal("mouse_move"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("mouse_down"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    button: z.enum(["left", "right", "middle"]).default("left"),
    x: z.number().int().nonnegative().optional().describe("Optional X (uses last pointer position if omitted)"),
    y: z.number().int().nonnegative().optional().describe("Optional Y (uses last pointer position if omitted)"),
  }),
  z.object({
    type: z.literal("mouse_up"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    button: z.enum(["left", "right", "middle", "all"]).default("left"),
    x: z.number().int().nonnegative().optional().describe("Optional X (uses last pointer position if omitted)"),
    y: z.number().int().nonnegative().optional().describe("Optional Y (uses last pointer position if omitted)"),
  }),
  z.object({
    type: z.literal("type_text"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    text: z.string().min(1),
    keyboard_layout: z.enum(["en-US", "es-ES"]).default("en-US").describe("Keyboard layout for deterministic text typing"),
    delay_ms: z.number().int().nonnegative().default(8).describe("Delay between characters in milliseconds"),
    text_strategy: z.enum(["auto", "clipboard", "vnc_keys"]).default("auto").describe("Text input strategy"),
  }),
  z.object({
    type: z.literal("press_key"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    key: z.string().min(1),
  }),
  z.object({
    type: z.literal("key_down"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    key: z.string().min(1).describe('Key or combo (e.g. "shift", "ctrl", "a", "ctrl+shift")'),
  }),
  z.object({
    type: z.literal("key_up"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    key: z.string().min(1).describe('Key or combo (e.g. "shift", "ctrl", "a", "ctrl+shift")'),
  }),
  z.object({
    type: z.literal("drag"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    from_x: z.number().int().nonnegative(),
    from_y: z.number().int().nonnegative(),
    to_x: z.number().int().nonnegative(),
    to_y: z.number().int().nonnegative(),
    steps: z.number().int().positive().default(20),
    duration_ms: z.number().int().positive().default(500),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).default("ease-in-out"),
    hold_start_ms: z.number().int().nonnegative().default(50).describe("Pause after move+press before drag interpolation"),
    hold_end_ms: z.number().int().nonnegative().default(50).describe("Pause before releasing button at end of drag"),
  }),
  z.object({
    type: z.literal("scroll"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid/active session)"),
    node: z.string().optional().describe("Used only when auto-connecting VNC"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().positive().default(3),
  }),
  z.object({
    type: z.literal("exec_command"),
    vmid: z.number().int().positive().optional().describe("VM ID (falls back to timeline vmid)"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    timeout_ms: z.number().int().positive().default(30_000).describe("Command timeout in milliseconds"),
  }),
]);

const timelineStepSchema = z.object({
  at_ms: z.number().int().nonnegative().optional().describe("Optional absolute offset from timeline start in milliseconds"),
  action: timelineActionSchema,
});

function mouseButtonToBit(button: "left" | "right" | "middle"): number {
  return button === "left" ? 1 : button === "middle" ? 2 : 4;
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "pve-computer-use",
  version: "0.1.0",
});

// --- Tool: connect ---

server.registerTool("connect", {
  title: "Connect to VM",
  description: "Connect to a Proxmox VE virtual machine's display via VNC. Must be called before other tools.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID (e.g. 100)"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const session = await sessions.connect(vmid, node);
  const fb = session.screen;
  activeVmid = vmid;

  return {
    content: [{
      type: "text" as const,
      text: `Connected to VM ${vmid} on node ${session.node}. Screen size: ${fb?.width}x${fb?.height}`,
    }],
  };
});

// --- Tool: screenshot ---

server.registerTool("screenshot", {
  title: "Screenshot",
  description: "Capture a screenshot of the VM's current display. Returns a JPEG image.",
  inputSchema: {
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
    save_path: z.string().optional().describe("Optional host path to save the JPEG file (e.g. /tmp/vm-500.jpg)."),
  },
}, async ({ vmid, save_path }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);

  // Request a fresh full update and wait for it
  session.requestFullUpdate();
  await session.waitForUpdate(3000);

  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const screenshot = await captureScreenshot(fb);
  lastScreenSize.set(id, { width: screenshot.width, height: screenshot.height });
  const jpegBuffer = Buffer.from(screenshot.data, "base64");

  let saveText: string | null = null;
  if (save_path) {
    const targetPath = resolvePath(save_path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, jpegBuffer);
    saveText = `Saved: ${targetPath}`;
  }

  return {
    content: [{
      type: "image" as const,
      data: screenshot.data,
      mimeType: "image/jpeg" as const,
    }, {
      type: "text" as const,
      text: saveText
        ? `Screenshot: ${screenshot.width}x${screenshot.height}\n${saveText}`
        : `Screenshot: ${screenshot.width}x${screenshot.height}`,
    }],
  };
});

// --- Tool: mouse_click ---

server.registerTool("mouse_click", {
  title: "Mouse Click",
  description: "Click at a position on the VM screen. Coordinates are in screen pixels.",
  inputSchema: {
    x: z.number().int().nonnegative().describe("X coordinate on screen"),
    y: z.number().int().nonnegative().describe("Y coordinate on screen"),
    button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ x, y, button, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const warnings = validateCoordinates(id, [{ x, y }], fb);
  session.click(x, y, button);

  const text = `Clicked ${button} at (${x}, ${y})`;
  return {
    content: [{
      type: "text" as const,
      text: warnings.length ? `${warnings.join("\n")}\n${text}` : text,
    }],
  };
});

// --- Tool: mouse_move ---

server.registerTool("mouse_move", {
  title: "Mouse Move",
  description: "Move the mouse cursor to a position on the VM screen without clicking.",
  inputSchema: {
    x: z.number().int().nonnegative().describe("X coordinate on screen"),
    y: z.number().int().nonnegative().describe("Y coordinate on screen"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ x, y, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const warnings = validateCoordinates(id, [{ x, y }], fb);
  session.sendPointerEvent(0, x, y);

  const text = `Moved mouse to (${x}, ${y})`;
  return {
    content: [{
      type: "text" as const,
      text: warnings.length ? `${warnings.join("\n")}\n${text}` : text,
    }],
  };
});

// --- Tool: type_text ---

server.registerTool("type_text", {
  title: "Type Text",
  description: "Type text into the VM using an intent-based strategy (auto/clipboard/vnc_keys).",
  inputSchema: {
    text: z.string().min(1).describe("Text to type"),
    keyboard_layout: z.enum(["en-US", "es-ES"]).default("en-US").describe("Keyboard layout for deterministic text typing"),
    delay_ms: z.number().int().nonnegative().default(8).describe("Delay between characters in milliseconds for app-side reliability"),
    text_strategy: z.enum(["auto", "clipboard", "vnc_keys"]).default("auto").describe("Text input strategy"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ text, keyboard_layout, delay_ms, text_strategy, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const backend = await typeTextByStrategy(id, session, text, keyboard_layout, delay_ms, text_strategy);

  return {
    content: [{
      type: "text" as const,
      text: `Typed ${text.length} character(s) via ${backend}`,
    }],
  };
});

// --- Tool: press_key ---

server.registerTool("press_key", {
  title: "Press Key",
  description: 'Press a key or key combination. Examples: "Return", "ctrl+c", "alt+tab", "shift+a", "F5", "Escape"',
  inputSchema: {
    key: z.string().min(1).describe('Key or combo (e.g. "Return", "ctrl+c", "alt+tab")'),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ key, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);

  session.pressKey(key);

  return {
    content: [{
      type: "text" as const,
      text: `Pressed key: ${key}`,
    }],
  };
});

// --- Tool: drag ---

server.registerTool("drag", {
  title: "Drag",
  description: "Drag from one position to another on the VM screen with animated easing.",
  inputSchema: {
    from_x: z.number().int().nonnegative().describe("Start X on screen"),
    from_y: z.number().int().nonnegative().describe("Start Y on screen"),
    to_x: z.number().int().nonnegative().describe("End X on screen"),
    to_y: z.number().int().nonnegative().describe("End Y on screen"),
    steps: z.number().int().positive().default(20).describe("Intermediate pointer steps (default 20)"),
    duration_ms: z.number().int().positive().default(500).describe("Total drag duration in ms (default 500)"),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).default("ease-in-out").describe("Easing curve (default ease-in-out)"),
    hold_start_ms: z.number().int().nonnegative().default(50).describe("Pause after move+press before drag interpolation"),
    hold_end_ms: z.number().int().nonnegative().default(50).describe("Pause before releasing button at end of drag"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ from_x, from_y, to_x, to_y, steps, duration_ms, easing, hold_start_ms, hold_end_ms, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const warnings = validateCoordinates(id, [{ x: from_x, y: from_y }, { x: to_x, y: to_y }], fb);
  await session.drag(from_x, from_y, to_x, to_y, steps, duration_ms, easing, hold_start_ms, hold_end_ms);

  const text = `Dragged from (${from_x}, ${from_y}) to (${to_x}, ${to_y}) [${steps} steps, ${duration_ms}ms, ${easing}, hold_start=${hold_start_ms}ms, hold_end=${hold_end_ms}ms]`;
  return {
    content: [{
      type: "text" as const,
      text: warnings.length ? `${warnings.join("\n")}\n${text}` : text,
    }],
  };
});

// --- Tool: scroll ---

server.registerTool("scroll", {
  title: "Scroll",
  description: "Scroll the mouse wheel at a position on the VM screen.",
  inputSchema: {
    x: z.number().int().nonnegative().describe("X coordinate on screen"),
    y: z.number().int().nonnegative().describe("Y coordinate on screen"),
    direction: z.enum(["up", "down"]).describe("Scroll direction"),
    amount: z.number().int().positive().default(3).describe("Number of scroll clicks"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ x, y, direction, amount, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const warnings = validateCoordinates(id, [{ x, y }], fb);
  session.scroll(x, y, direction, amount);

  const text = `Scrolled ${direction} ${amount} clicks at (${x}, ${y})`;
  return {
    content: [{
      type: "text" as const,
      text: warnings.length ? `${warnings.join("\n")}\n${text}` : text,
    }],
  };
});

// --- Tool: get_screen_size ---

server.registerTool("get_screen_size", {
  title: "Get Screen Size",
  description: "Get the current screen dimensions of the VM.",
  inputSchema: {
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  return {
    content: [{
      type: "text" as const,
      text: `Screen size: ${fb.width}x${fb.height}`,
    }],
  };
});

// --- Tool: disconnect ---

server.registerTool("disconnect", {
  title: "Disconnect from VM",
  description: "Disconnect the VNC session for a VM.",
  inputSchema: {
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ vmid }) => {
  const id = resolveVmid(vmid);
  sessions.disconnect(id);
  if (activeVmid === id) activeVmid = null;

  return {
    content: [{
      type: "text" as const,
      text: `Disconnected from VM ${id}`,
    }],
  };
});

// --- Tool: list_vms ---

server.registerTool("list_vms", {
  title: "List VMs",
  description: "List QEMU virtual machines visible to the authenticated user, optionally filtered by VM ID, tag, status, or name. Shows vmid, name, status, node, and tags.",
  inputSchema: {
    vmids: z.array(z.number().int().positive()).optional().describe("Optional list of exact VM IDs to include."),
    tags: z.array(z.string().min(1)).optional().describe("Optional list of VM tags. A VM matches if it has any requested tag."),
    statuses: z.array(z.string().min(1)).optional().describe("Optional list of VM status values to include (for example: running, stopped)."),
    name: z.string().min(1).optional().describe("Optional case-insensitive substring filter for the VM name."),
  },
}, async ({ vmids, tags, statuses, name }) => {
  const normalizedName = name?.trim().toLowerCase();
  const normalizedTags = tags
    ?.map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const normalizedStatuses = statuses
    ?.map((status) => status.trim())
    .filter((status) => status.length > 0);
  const vms = (await api.listVms()).filter((vm) => matchesVmFilters(vm, {
    vmids,
    tags: normalizedTags && normalizedTags.length > 0 ? normalizedTags : undefined,
    statuses: normalizedStatuses && normalizedStatuses.length > 0 ? normalizedStatuses : undefined,
    name: normalizedName && normalizedName.length > 0 ? normalizedName : undefined,
  }));

  if (vms.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: "No VMs found for the requested filters (or no permissions to view any).",
      }],
    };
  }

  const lines = vms.map((vm) => {
    return `VM ${vm.vmid}: name=${vm.name ?? "unknown"}, status=${vm.status}, node=${vm.node}, tags=${formatVmTags(vm.tags)}`;
  });

  return {
    content: [{
      type: "text" as const,
      text: lines.join("\n"),
    }],
  };
});

// --- Optional tools: VM power management ---

server.registerTool("vm_start", {
  title: "Start VM",
  description: "Start a stopped VM. Requires VM.PowerMgmt privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.startVm(resolvedNode, vmid);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} started successfully`,
    }],
  };
});

server.registerTool("vm_shutdown", {
  title: "Shutdown VM",
  description: "Gracefully shutdown a VM via ACPI power-off. Requires VM.PowerMgmt privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.shutdownVm(resolvedNode, vmid);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} shutdown completed`,
    }],
  };
});

server.registerTool("vm_stop", {
  title: "Stop VM",
  description: "Force stop a VM (like pulling the power cord). Requires VM.PowerMgmt privilege. Prefer vm_shutdown for graceful shutdown.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.stopVm(resolvedNode, vmid);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} force stopped`,
    }],
  };
});

server.registerTool("vm_status", {
  title: "VM Status",
  description: "Get the current status of a VM, including tags. Requires VM.Audit privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  const [status, config] = await Promise.all([
    api.getVmStatus(resolvedNode, vmid),
    api.getVmConfig(resolvedNode, vmid),
  ]);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid}: status=${status.status}, qmpstatus=${status.qmpstatus ?? "n/a"}, name=${status.name ?? config.name ?? "unknown"}, tags=${formatVmTags(config.tags)}`,
    }],
  };
});

server.registerTool("vm_notes", {
  title: "VM Notes",
  description: "Read the VM notes/description from Proxmox config. Requires VM.Audit privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  const config = await api.getVmConfig(resolvedNode, vmid);
  const notes = config.description?.trim();

  return {
    content: [{
      type: "text" as const,
      text: notes
        ? `VM ${vmid} notes:\n${notes}`
        : `VM ${vmid} has no notes set.`,
    }],
  };
});

server.registerTool("vm_disk_list", {
  title: "List VM Disk Config",
  description: "List disk-like VM config entries such as scsi0, virtio0, efidisk0, tpmstate0, and unusedN. Includes the raw config string for each entry.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  const disks = await api.getVmDiskConfig(resolvedNode, vmid);

  if (disks.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `VM ${vmid} has no disk-like config entries.`,
      }],
    };
  }

  const lines = disks.map((disk) => {
    const parsed = disk.parsed
      ? ` storage=${disk.parsed.storage} volume=${disk.parsed.volume}`
      : "";
    return `${disk.key}: ${disk.spec}${parsed}`;
  });

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} disk config on node ${resolvedNode}:\n${lines.join("\n")}`,
    }],
  };
});

server.registerTool("vm_disk_set", {
  title: "Set VM Disk Config",
  description: "Set a disk-like VM config entry such as scsi0, virtio0, efidisk0, tpmstate0, or unusedN to a raw Proxmox config string.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    disk: z.string().min(1).describe("Disk config key, for example scsi0, efidisk0, or unused0."),
    value: z.string().min(1).describe("Raw Proxmox disk config value, for example local-lvm:0,efitype=4m."),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, disk, value, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.setVmConfigValue(resolvedNode, vmid, disk, value);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} updated ${disk} on node ${resolvedNode} to: ${value}`,
    }],
  };
});

server.registerTool("vm_config_delete", {
  title: "Delete VM Config Entry",
  description: "Delete a VM config entry through the Proxmox config API. This is commonly used for disk-like keys such as efidisk0 or unusedN.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    key: z.string().min(1).describe("VM config key to delete, for example efidisk0 or unused0."),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, key, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.deleteVmConfigValue(resolvedNode, vmid, key);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} deleted config key ${key} on node ${resolvedNode}`,
    }],
  };
});

server.registerTool("exec_command", {
  title: "Execute Command in VM",
  description: "Execute a command inside the VM via QEMU guest agent. Requires qemu-guest-agent running in the VM and VM.GuestAgent.Unrestricted privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    command: z.string().min(1).describe("Command to execute (full path recommended, e.g. /usr/bin/ls). For env vars or shell features use /bin/bash -c."),
    args: z.array(z.string()).optional().describe("Command arguments (e.g. [\"--output\", \"Virtual-1\", \"--mode\", \"1280x720\"])"),
    timeout_ms: z.number().int().positive().default(30_000).describe("Command timeout in milliseconds"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, command, args, timeout_ms, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  const result = await api.guestExec(resolvedNode, vmid, command, args, timeout_ms);

  return {
    content: [{
      type: "text" as const,
      text: `Exit code: ${result.exitcode}\nStdout: ${result.stdout}\nStderr: ${result.stderr}`,
    }],
  };
});

server.registerTool("timeline", {
  title: "Run Timeline",
  description: "Execute a sequence of scheduled actions (KVM + guest-agent) in one call.",
  inputSchema: {
    vmid: z.number().int().positive().optional().describe("Default VM ID for steps that omit vmid."),
    continue_on_error: z.boolean().default(false).describe("Continue executing remaining steps after an error."),
    release_inputs_at_end: z.boolean().default(true).describe("Release held mouse buttons/keys at timeline end (recommended)."),
    steps: z.array(timelineStepSchema).min(1).describe("Timeline steps. Use at_ms for absolute scheduling from start."),
  },
}, async ({ vmid, continue_on_error, release_inputs_at_end, steps }) => {
  const startedAt = Date.now();
  const logs: string[] = [];
  let successCount = 0;
  let failedCount = 0;
  let aborted = false;
  const pointerMaskByVm = new Map<number, number>();
  const pointerPosByVm = new Map<number, { x: number; y: number }>();
  const heldKeysByVm = new Map<number, Set<number>>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNo = i + 1;

    if (step.at_ms !== undefined) {
      const elapsed = Date.now() - startedAt;
      const delay = step.at_ms - elapsed;
      if (delay > 0) await sleep(delay);
    }

    try {
      const action = step.action;
      let message: string;

      switch (action.type) {
        case "wait": {
          await sleep(action.duration_ms);
          message = `waited ${action.duration_ms}ms`;
          break;
        }
        case "connect": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          await getOrConnectVncSession(id, action.node);
          message = `connected VNC session for VM ${id}`;
          break;
        }
        case "mouse_click": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          const fb = session.screen;
          if (!fb) throw new Error("Framebuffer not ready");
          const warnings = validateCoordinates(id, [{ x: action.x, y: action.y }], fb);
          const currentMask = pointerMaskByVm.get(id) ?? 0;
          const buttonBit = mouseButtonToBit(action.button);
          const downMask = currentMask | buttonBit;
          session.sendPointerEvent(currentMask, action.x, action.y);
          session.sendPointerEvent(downMask, action.x, action.y);
          session.sendPointerEvent(currentMask, action.x, action.y);
          pointerPosByVm.set(id, { x: action.x, y: action.y });
          message = `${warnings.length ? `${warnings.join(" | ")} | ` : ""}clicked ${action.button} at (${action.x}, ${action.y})`;
          break;
        }
        case "mouse_move": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          const fb = session.screen;
          if (!fb) throw new Error("Framebuffer not ready");
          const warnings = validateCoordinates(id, [{ x: action.x, y: action.y }], fb);
          const currentMask = pointerMaskByVm.get(id) ?? 0;
          session.sendPointerEvent(currentMask, action.x, action.y);
          pointerPosByVm.set(id, { x: action.x, y: action.y });
          message = `${warnings.length ? `${warnings.join(" | ")} | ` : ""}moved mouse to (${action.x}, ${action.y})`;
          break;
        }
        case "mouse_down": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          const fb = session.screen;
          if (!fb) throw new Error("Framebuffer not ready");
          const currentMask = pointerMaskByVm.get(id) ?? 0;
          const lastPos = pointerPosByVm.get(id);
          const x = action.x ?? lastPos?.x;
          const y = action.y ?? lastPos?.y;
          if (x === undefined || y === undefined) {
            throw new Error("mouse_down requires x/y or a previous mouse position in the same timeline");
          }
          const warnings = validateCoordinates(id, [{ x, y }], fb);
          const newMask = currentMask | mouseButtonToBit(action.button);
          session.sendPointerEvent(newMask, x, y);
          pointerMaskByVm.set(id, newMask);
          pointerPosByVm.set(id, { x, y });
          message = `${warnings.length ? `${warnings.join(" | ")} | ` : ""}mouse down ${action.button} at (${x}, ${y})`;
          break;
        }
        case "mouse_up": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          const fb = session.screen;
          if (!fb) throw new Error("Framebuffer not ready");
          const currentMask = pointerMaskByVm.get(id) ?? 0;
          const lastPos = pointerPosByVm.get(id);
          const x = action.x ?? lastPos?.x;
          const y = action.y ?? lastPos?.y;
          if (x === undefined || y === undefined) {
            throw new Error("mouse_up requires x/y or a previous mouse position in the same timeline");
          }
          const warnings = validateCoordinates(id, [{ x, y }], fb);
          const newMask = action.button === "all"
            ? 0
            : (currentMask & ~mouseButtonToBit(action.button));
          session.sendPointerEvent(newMask, x, y);
          pointerMaskByVm.set(id, newMask);
          pointerPosByVm.set(id, { x, y });
          message = `${warnings.length ? `${warnings.join(" | ")} | ` : ""}mouse up ${action.button} at (${x}, ${y})`;
          break;
        }
        case "type_text": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          const backend = await typeTextByStrategy(id, session, action.text, action.keyboard_layout, action.delay_ms, action.text_strategy);
          message = `typed ${action.text.length} character(s) via ${backend}`;
          break;
        }
        case "press_key": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          session.pressKey(action.key);
          message = `pressed key: ${action.key}`;
          break;
        }
        case "key_down": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          const keysyms = parseKeyCombo(action.key);
          for (const keysym of keysyms) session.sendKeyEvent(true, keysym);
          let held = heldKeysByVm.get(id);
          if (!held) {
            held = new Set<number>();
            heldKeysByVm.set(id, held);
          }
          for (const keysym of keysyms) held.add(keysym);
          message = `key down: ${action.key}`;
          break;
        }
        case "key_up": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          const keysyms = parseKeyCombo(action.key);
          for (let j = keysyms.length - 1; j >= 0; j--) session.sendKeyEvent(false, keysyms[j]);
          const held = heldKeysByVm.get(id);
          if (held) {
            for (const keysym of keysyms) held.delete(keysym);
          }
          message = `key up: ${action.key}`;
          break;
        }
        case "drag": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          const fb = session.screen;
          if (!fb) throw new Error("Framebuffer not ready");
          const warnings = validateCoordinates(
            id,
            [{ x: action.from_x, y: action.from_y }, { x: action.to_x, y: action.to_y }],
            fb,
          );
          await session.drag(
            action.from_x,
            action.from_y,
            action.to_x,
            action.to_y,
            action.steps,
            action.duration_ms,
            action.easing,
            action.hold_start_ms,
            action.hold_end_ms,
          );
          pointerPosByVm.set(id, { x: action.to_x, y: action.to_y });
          pointerMaskByVm.set(id, 0);
          message = `${warnings.length ? `${warnings.join(" | ")} | ` : ""}dragged (${action.from_x},${action.from_y})->(${action.to_x},${action.to_y})`;
          break;
        }
        case "scroll": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const session = await getOrConnectVncSession(id, action.node);
          const fb = session.screen;
          if (!fb) throw new Error("Framebuffer not ready");
          const warnings = validateCoordinates(id, [{ x: action.x, y: action.y }], fb);
          const currentMask = pointerMaskByVm.get(id) ?? 0;
          const wheelBit = action.direction === "up" ? 8 : 16;
          for (let w = 0; w < action.amount; w++) {
            session.sendPointerEvent(currentMask | wheelBit, action.x, action.y);
            session.sendPointerEvent(currentMask, action.x, action.y);
          }
          pointerPosByVm.set(id, { x: action.x, y: action.y });
          message = `${warnings.length ? `${warnings.join(" | ")} | ` : ""}scrolled ${action.direction} x${action.amount} at (${action.x}, ${action.y})`;
          break;
        }
        case "exec_command": {
          const id = resolveTimelineVmid(action.vmid, vmid);
          const resolvedNode = action.node ?? await api.findVmNode(id);
          const result = await api.guestExec(resolvedNode, id, action.command, action.args, action.timeout_ms);
          message = `exec (${action.command}) exit=${result.exitcode}`;
          break;
        }
      }

      successCount++;
      logs.push(`[${Date.now() - startedAt}ms] step ${stepNo} OK: ${message}`);
    } catch (err) {
      failedCount++;
      const msg = err instanceof Error ? err.message : String(err);
      logs.push(`[${Date.now() - startedAt}ms] step ${stepNo} ERROR: ${msg}`);
      if (!continue_on_error) {
        aborted = true;
        break;
      }
    }
  }

  if (release_inputs_at_end) {
    for (const [id, mask] of pointerMaskByVm) {
      if (mask !== 0) {
        const session = sessions.getSession(id);
        if (session?.connected) {
          const pos = pointerPosByVm.get(id) ?? { x: 0, y: 0 };
          session.sendPointerEvent(0, pos.x, pos.y);
        }
      }
    }
    for (const [id, held] of heldKeysByVm) {
      if (held.size > 0) {
        const session = sessions.getSession(id);
        if (session?.connected) {
          const toRelease = Array.from(held.values());
          for (let i = toRelease.length - 1; i >= 0; i--) {
            session.sendKeyEvent(false, toRelease[i]);
          }
        }
      }
    }
  }

  const status = aborted ? "aborted" : "completed";
  return {
    content: [{
      type: "text" as const,
      text: `Timeline ${status}: ${successCount} succeeded, ${failedCount} failed, total=${steps.length}\n${logs.join("\n")}`,
    }],
  };
});

// --- Snapshot tools ---

server.registerTool("snapshot_list", {
  title: "List Snapshots",
  description: "List all snapshots for a VM. Requires VM.Audit privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  const snapshots = await api.listSnapshots(resolvedNode, vmid);

  // Filter out the "current" pseudo-snapshot
  const real = snapshots.filter((s) => s.name !== "current");

  if (real.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `VM ${vmid} has no snapshots.`,
      }],
    };
  }

  const lines = real.map((s) => {
    const time = s.snaptime ? new Date(s.snaptime * 1000).toISOString() : "n/a";
    const desc = s.description ?? "";
    const mem = s.vmstate ? " [+memory]" : "";
    return `  ${s.name} — ${time}${mem}${desc ? ` — ${desc}` : ""}`;
  });

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} snapshots:\n${lines.join("\n")}`,
    }],
  };
});

server.registerTool("snapshot_create", {
  title: "Create Snapshot",
  description: "Create a snapshot of a VM. Requires VM.Snapshot privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    name: z.string().min(1).describe("Snapshot name"),
    description: z.string().optional().describe("Snapshot description"),
    vmstate: z.boolean().default(false).describe("Include VM memory state (default false)"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, name, description, vmstate, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.createSnapshot(resolvedNode, vmid, name, description, vmstate);

  return {
    content: [{
      type: "text" as const,
      text: `Snapshot "${name}" created for VM ${vmid}${vmstate ? " (with memory state)" : ""}`,
    }],
  };
});

server.registerTool("snapshot_delete", {
  title: "Delete Snapshot",
  description: "Delete a snapshot from a VM. Requires VM.Snapshot privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    name: z.string().min(1).describe("Snapshot name to delete"),
    force: z.boolean().default(false).describe("Force removal of stuck snapshots (default false)"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, name, force, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.deleteSnapshot(resolvedNode, vmid, name, force);

  return {
    content: [{
      type: "text" as const,
      text: `Snapshot "${name}" deletion requested for VM ${vmid}`,
    }],
  };
});

server.registerTool("snapshot_rollback", {
  title: "Rollback Snapshot",
  description: "Rollback a VM to a previous snapshot. The VM will be stopped and restored. Requires VM.Snapshot privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    name: z.string().min(1).describe("Snapshot name to rollback to"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, name, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.rollbackSnapshot(resolvedNode, vmid, name);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} rollback to snapshot "${name}" requested`,
    }],
  };
});

// --- Backup tools ---

server.registerTool("backup_create", {
  title: "Create Backup",
  description: "Create a backup (vzdump) of a VM. Requires VM.Backup privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    storage: z.string().optional().describe("Target storage (must support backups)"),
    compress: z.enum(["0", "gzip", "lzo", "zstd"]).default("zstd").describe("Compression algorithm (default zstd)"),
    mode: z.enum(["snapshot", "stop", "suspend"]).default("snapshot").describe("Backup mode: snapshot (live), stop (consistent), suspend (compat)"),
    notes: z.string().optional().describe("Backup notes template"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, storage, compress, mode, notes, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.createBackup(resolvedNode, vmid, storage, compress, mode, notes);

  return {
    content: [{
      type: "text" as const,
      text: `Backup of VM ${vmid} started (mode=${mode}, compress=${compress}${storage ? `, storage=${storage}` : ""})`,
    }],
  };
});

server.registerTool("backup_list", {
  title: "List Backups",
  description: "List backup files from a storage. Requires access to the storage.",
  inputSchema: {
    storage: z.string().describe("Storage name to list backups from"),
    vmid: z.number().int().positive().optional().describe("Filter by VM ID"),
    node: z.string().describe("PVE node name"),
  },
}, async ({ storage, vmid, node }) => {
  const backups = await api.listBackups(node, storage, vmid);

  if (backups.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `No backups found in storage "${storage}"${vmid ? ` for VM ${vmid}` : ""}.`,
      }],
    };
  }

  const lines = backups.map((b) => {
    const time = new Date(b.ctime * 1000).toISOString();
    const sizeMb = (b.size / 1024 / 1024).toFixed(1);
    const prot = b.protected ? " [protected]" : "";
    return `  ${b.volid} — ${time} — ${sizeMb} MB${prot}${b.notes ? ` — ${b.notes}` : ""}`;
  });

  return {
    content: [{
      type: "text" as const,
      text: `Backups in "${storage}"${vmid ? ` for VM ${vmid}` : ""}:\n${lines.join("\n")}`,
    }],
  };
});

// --- Serial console tools ---

server.registerTool("serial_connect", {
  title: "Connect to Serial Console",
  description: "Connect to a VM's serial console (text terminal). For headless VMs, servers, or text-based environments. Requires VM.Console privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID (e.g. 100)"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
    cols: z.number().int().positive().default(80).describe("Terminal columns (default 80)"),
    rows: z.number().int().positive().default(24).describe("Terminal rows (default 24)"),
  },
}, async ({ vmid, node, cols, rows }) => {
  const session = await termSessions.connect(vmid, node, cols, rows);
  activeTermVmid = vmid;

  return {
    content: [{
      type: "text" as const,
      text: `Connected to serial console on VM ${vmid} (node ${session.node}, ${cols}x${rows})`,
    }],
  };
});

server.registerTool("serial_read", {
  title: "Read Serial Console",
  description: "Read the current terminal screen as plain text. Returns what a human would see on the console.",
  inputSchema: {
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active terminal session if omitted."),
  },
}, async ({ vmid }) => {
  const id = resolveTermVmid(vmid);
  const session = termSessions.getConnectedSession(id);

  // Wait briefly for any pending data
  await session.waitForData(500);

  const screen = session.getScreen();

  return {
    content: [{
      type: "text" as const,
      text: screen || "(empty screen)",
    }],
  };
});

server.registerTool("serial_send", {
  title: "Send Text to Serial Console",
  description: "Send text input to the serial console. Use \\n for newline to execute commands.",
  inputSchema: {
    text: z.string().min(1).describe("Text to send (e.g. \"ls -la\\n\")"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active terminal session if omitted."),
  },
}, async ({ text, vmid }) => {
  const id = resolveTermVmid(vmid);
  const session = termSessions.getConnectedSession(id);

  session.sendInput(text);

  return {
    content: [{
      type: "text" as const,
      text: `Sent ${text.length} character(s) to VM ${id} serial console`,
    }],
  };
});

server.registerTool("serial_key", {
  title: "Send Key to Serial Console",
  description: 'Send a key or key combination to the serial console. Examples: "enter", "ctrl+c", "ctrl+d", "up", "tab", "f1", "escape"',
  inputSchema: {
    key: z.string().min(1).describe('Key or combo (e.g. "enter", "ctrl+c", "up", "f5")'),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active terminal session if omitted."),
  },
}, async ({ key, vmid }) => {
  const id = resolveTermVmid(vmid);
  const session = termSessions.getConnectedSession(id);

  session.sendKey(key);

  return {
    content: [{
      type: "text" as const,
      text: `Sent key: ${key}`,
    }],
  };
});

server.registerTool("serial_resize", {
  title: "Resize Serial Console",
  description: "Resize the terminal dimensions. Affects how screen content is laid out.",
  inputSchema: {
    cols: z.number().int().positive().describe("New column count"),
    rows: z.number().int().positive().describe("New row count"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active terminal session if omitted."),
  },
}, async ({ cols, rows, vmid }) => {
  const id = resolveTermVmid(vmid);
  const session = termSessions.getConnectedSession(id);

  session.resize(cols, rows);

  return {
    content: [{
      type: "text" as const,
      text: `Resized terminal to ${cols}x${rows}`,
    }],
  };
});

server.registerTool("serial_disconnect", {
  title: "Disconnect Serial Console",
  description: "Disconnect the serial console session for a VM.",
  inputSchema: {
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active terminal session if omitted."),
  },
}, async ({ vmid }) => {
  const id = resolveTermVmid(vmid);
  termSessions.disconnect(id);
  if (activeTermVmid === id) activeTermVmid = null;

  return {
    content: [{
      type: "text" as const,
      text: `Disconnected serial console for VM ${id}`,
    }],
  };
});

// --- Main ---

async function main(): Promise<void> {
  const credentials = loadCredentialsFromEnv();
  auth = new PveAuthManager(credentials);
  api = new PveApiClient(auth);
  sessions = new VncSessionManager(api);
  termSessions = new TerminalSessionManager(api);

  // Authenticate immediately to fail fast on bad credentials
  await auth.authenticate();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  sessions?.disconnectAll();
  termSessions?.disconnectAll();
  auth?.destroy();
  destroyDispatchers();
  process.exit(0);
}
