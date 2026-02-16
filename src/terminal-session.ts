/**
 * Terminal Session Manager
 *
 * Manages persistent WebSocket serial console connections to PVE virtual machines.
 * Uses @xterm/headless for terminal state emulation and @xterm/addon-serialize
 * for reading the screen as plain text.
 *
 * Unlike VNC, terminal WebSocket is raw bidirectional text — no RFB handshake.
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;
import addonSerialize from "@xterm/addon-serialize";
const { SerializeAddon } = addonSerialize;
import type { PveApiClient } from "./pve-api.js";

/** Map of key combo names to terminal escape sequences. */
const KEY_SEQUENCES: Record<string, string> = {
  // Control keys
  "ctrl+a": "\x01",
  "ctrl+b": "\x02",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+e": "\x05",
  "ctrl+f": "\x06",
  "ctrl+g": "\x07",
  "ctrl+h": "\x08",
  "ctrl+i": "\x09",
  "ctrl+j": "\x0a",
  "ctrl+k": "\x0b",
  "ctrl+l": "\x0c",
  "ctrl+m": "\x0d",
  "ctrl+n": "\x0e",
  "ctrl+o": "\x0f",
  "ctrl+p": "\x10",
  "ctrl+q": "\x11",
  "ctrl+r": "\x12",
  "ctrl+s": "\x13",
  "ctrl+t": "\x14",
  "ctrl+u": "\x15",
  "ctrl+v": "\x16",
  "ctrl+w": "\x17",
  "ctrl+x": "\x18",
  "ctrl+y": "\x19",
  "ctrl+z": "\x1a",
  "ctrl+[": "\x1b",
  "ctrl+\\": "\x1c",
  "ctrl+]": "\x1d",

  // Named keys
  enter: "\r",
  return: "\r",
  tab: "\t",
  escape: "\x1b",
  esc: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",

  // Function keys
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

/**
 * Convert a key combo string to its terminal escape sequence.
 * Supports: "ctrl+c", "enter", "up", "f5", etc.
 */
function keyComboToSequence(combo: string): string {
  const normalized = combo.toLowerCase().trim();
  const seq = KEY_SEQUENCES[normalized];
  if (seq) return seq;

  // Single character — send as-is
  if (normalized.length === 1) return normalized;

  throw new Error(
    `Unknown key combo: "${combo}". Supported: ${Object.keys(KEY_SEQUENCES).join(", ")}`,
  );
}

export class TerminalSession extends EventEmitter {
  readonly node: string;
  readonly vmid: number;

  private api: PveApiClient;
  private ws: WebSocket | null = null;
  private terminal: InstanceType<typeof Terminal>;
  private serializer: InstanceType<typeof SerializeAddon>;
  private _connected = false;

  constructor(api: PveApiClient, options: { node: string; vmid: number; cols?: number; rows?: number }) {
    super();
    this.api = api;
    this.node = options.node;
    this.vmid = options.vmid;

    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    this.terminal = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      convertEol: true,
    });

    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);

    this.on("error", (err: Error) => {
      console.error(`[Terminal ${this.vmid}] ${err.message}`);
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the VM's serial console via PVE termproxy + WebSocket.
   */
  async connect(): Promise<void> {
    const proxy = await this.api.termProxy(this.node, this.vmid);
    const wsUrl = this.api.getTermWebSocketUrl(this.node, this.vmid, proxy.port, proxy.ticket);
    const cookie = await this.api.getAuthCookie();

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      };

      const succeed = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      };

      const timeout = setTimeout(() => {
        fail(new Error("Terminal WebSocket connection timed out (10s)"));
        this.ws?.close();
      }, 10000);

      this.ws = new WebSocket(wsUrl, ["binary"], {
        headers: { Cookie: `PVEAuthCookie=${cookie}` },
        rejectUnauthorized: false,
      });

      this.ws.binaryType = "arraybuffer";

      let authenticated = false;

      this.ws.on("open", () => {
        // PVE termproxy requires user:ticket\n as the first WebSocket message
        this.ws!.send(proxy.user + ":" + proxy.ticket + "\n");
      });

      this.ws.on("message", (data: ArrayBuffer | Buffer) => {
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);

        if (!authenticated) {
          // First message should be "OK" (bytes 79, 75)
          const text = raw.toString("utf-8");
          if (text.startsWith("OK")) {
            authenticated = true;
            this._connected = true;
            // Send initial resize to sync terminal dimensions
            const cols = this.terminal.cols;
            const rows = this.terminal.rows;
            this.ws!.send(`1:${cols}:${rows}:`);
            // Allow initial data to arrive
            setTimeout(() => succeed(), 500);
          } else {
            fail(new Error(`Terminal auth failed: ${text}`));
          }
          return;
        }

        // After auth, write raw data directly to the terminal emulator
        this.terminal.write(raw);
        this.emit("data");
      });

      this.ws.on("error", (err) => {
        fail(err);
        this.emit("error", err);
      });

      this.ws.on("close", () => {
        const wasConnected = this._connected;
        this._connected = false;
        if (!wasConnected) {
          fail(new Error("WebSocket closed before connection established"));
        }
        this.emit("close");
      });
    });
  }

  /**
   * Send raw text input to the terminal.
   * Uses PVE's packet protocol: 0:LENGTH:DATA
   */
  sendInput(text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("Terminal not connected");
    }
    const byteLength = Buffer.byteLength(text, "utf-8");
    this.ws.send(`0:${byteLength}:${text}`);
  }

  /**
   * Send a key combo as its terminal escape sequence.
   * Examples: "ctrl+c", "enter", "up", "f5"
   */
  sendKey(combo: string): void {
    const seq = keyComboToSequence(combo);
    this.sendInput(seq);
  }

  /**
   * Get the current terminal screen as plain text.
   * Returns only the visible viewport, no ANSI escape codes.
   */
  getScreen(): string {
    // Serialize with scrollback=0 to get only the visible viewport
    const raw = this.serializer.serialize({ scrollback: 0, excludeModes: true, excludeAltBuffer: false });
    return stripAnsi(raw);
  }

  /**
   * Resize the terminal and notify the remote side.
   * Uses PVE's packet protocol: 1:COLS:ROWS:
   */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`1:${cols}:${rows}:`);
    }
  }

  /**
   * Wait for data to arrive on the terminal.
   */
  waitForData(timeoutMs: number = 2000): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener("data", onData);
        resolve();
      }, timeoutMs);
      timer.unref();

      const onData = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("data", onData);
    });
  }

  /**
   * Disconnect the terminal session.
   */
  disconnect(): void {
    this._connected = false;
    this.ws?.close();
    this.ws = null;
    this.serializer.dispose();
    this.terminal.dispose();
  }
}

/**
 * Strip ANSI escape sequences from text.
 * The serialize addon may include positioning sequences.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")  // OSC sequences
    .replace(/\x1b[()][0-9A-Z]/g, "")     // Character set designations
    .replace(/\x1b[=>]/g, "")             // Keypad modes
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "") // Private mode sequences
    .replace(/\x1b[78]/g, "");            // Save/restore cursor
}

/**
 * Manages multiple terminal sessions, one per VM.
 */
export class TerminalSessionManager {
  private sessions = new Map<number, TerminalSession>();
  private api: PveApiClient;

  constructor(api: PveApiClient) {
    this.api = api;
  }

  async connect(vmid: number, node?: string, cols?: number, rows?: number): Promise<TerminalSession> {
    const existing = this.sessions.get(vmid);
    if (existing?.connected) {
      return existing;
    }
    if (existing) {
      existing.disconnect();
    }

    const resolvedNode = node ?? (await this.api.findVmNode(vmid));

    const session = new TerminalSession(this.api, { node: resolvedNode, vmid, cols, rows });
    this.sessions.set(vmid, session);

    await session.connect();
    return session;
  }

  getConnectedSession(vmid: number): TerminalSession {
    const session = this.sessions.get(vmid);
    if (!session?.connected) {
      throw new Error(`No active terminal session for VM ${vmid}. Call serial_connect first.`);
    }
    return session;
  }

  disconnect(vmid: number): void {
    const session = this.sessions.get(vmid);
    if (session) {
      session.disconnect();
      this.sessions.delete(vmid);
    }
  }

  disconnectAll(): void {
    for (const [, session] of this.sessions) {
      session.disconnect();
    }
    this.sessions.clear();
  }
}
