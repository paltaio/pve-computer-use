/**
 * VNC Session Manager
 *
 * Manages persistent WebSocket VNC connections to PVE virtual machines.
 * Handles the full lifecycle:
 * 1. vncproxy API call to get port + ticket
 * 2. WebSocket connection (within 10s window)
 * 3. RFB 3.8 handshake (security type 1 = None via PVE proxy)
 * 4. Continuous framebuffer updates
 * 5. Reconnection on drop
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import type { PveApiClient } from "./pve-api.js";
import { vncDesEncrypt } from "./des.js";
import { Framebuffer } from "./framebuffer.js";
import {
  RFB_ENCODING_RAW,
  RFB_ENCODING_COPYRECT,
  RFB_ENCODING_DESKTOP_SIZE,
  RFB_ENCODING_EXTENDED_KEY,
  MSG_FB_UPDATE,
  MSG_SET_COLOUR_MAP,
  MSG_BELL,
  MSG_SERVER_CUT_TEXT,
  buildSetPixelFormat,
  buildSetEncodings,
  buildFbUpdateRequest,
  buildKeyEvent,
  buildPointerEvent,
  buildExtendedKeyEvent,
  charToKeysym,
  parseKeyCombo,
} from "./rfb.js";

/** Promise-based delay for animated operations. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Supported easing curves for drag animation. */
export type EasingType = "linear" | "ease-in" | "ease-out" | "ease-in-out";

const EASING_FUNCTIONS: Record<EasingType, (t: number) => number> = {
  "linear": (t) => t,
  "ease-in": (t) => t * t * t,
  "ease-out": (t) => 1 - (1 - t) ** 3,
  "ease-in-out": (t) => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2,
};

/**
 * Fallback mapping for shifted ASCII symbols to deterministic key combos.
 * This avoids layout-dependent ambiguity when sending raw shifted keysyms.
 */
const SHIFTED_CHAR_COMBOS: Record<string, string> = {
  "~": "shift+`",
  "!": "shift+1",
  "@": "shift+2",
  "#": "shift+3",
  "$": "shift+4",
  "%": "shift+5",
  "^": "shift+6",
  "&": "shift+7",
  "*": "shift+8",
  "(": "shift+9",
  ")": "shift+0",
  "_": "shift+-",
  "+": "shift+=",
  "{": "shift+[",
  "}": "shift+]",
  "|": "shift+\\",
  ":": "shift+;",
  "\"": "shift+'",
  "<": "shift+,",
  ">": "shift+.",
  "?": "shift+/",
};

export interface VncSessionOptions {
  node: string;
  vmid: number;
}

type HandshakeState =
  | "awaiting_version"
  | "awaiting_security_types"
  | "awaiting_vnc_challenge"
  | "awaiting_security_result"
  | "awaiting_server_init"
  | "connected";

export class VncSession extends EventEmitter {
  readonly node: string;
  readonly vmid: number;

  private api: PveApiClient;
  private ws: WebSocket | null = null;
  private framebuffer: Framebuffer | null = null;
  private recvBuffer = Buffer.alloc(0);
  private state: HandshakeState = "awaiting_version";
  private _connected = false;
  private supportsExtendedKey = false;
  private vncPassword: string = "";

  constructor(api: PveApiClient, options: VncSessionOptions) {
    super();
    this.api = api;
    this.node = options.node;
    this.vmid = options.vmid;
    // Prevent emit("error") from throwing when no external listener is registered.
    // Without this, any error in handleServerMessage/handleFramebufferUpdate
    // causes an unhandled throw that gets silently swallowed by the connect() catch.
    this.on("error", (err: Error) => {
      console.error(`[VNC ${this.vmid}] ${err.message}`);
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  get screen(): Framebuffer | null {
    return this.framebuffer;
  }

  async connect(): Promise<{ width: number; height: number }> {
    // Step 1: Get VNC proxy ticket
    const proxy = await this.api.vncProxy(this.node, this.vmid);
    this.vncPassword = proxy.password;

    // Step 2: Build WebSocket URL and connect (must happen within 10s)
    const wsUrl = this.api.getVncWebSocketUrl(this.node, this.vmid, proxy.port, proxy.ticket);
    const cookie = await this.api.getAuthCookie();

    return new Promise<{ width: number; height: number }>((resolve, reject) => {
      let settled = false;

      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      };

      const succeed = (width: number, height: number) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ width, height });
        }
      };

      const timeout = setTimeout(() => {
        fail(new Error("VNC WebSocket connection timed out (10s)"));
        this.ws?.close();
      }, 10000);

      this.ws = new WebSocket(wsUrl, ["binary"], {
        headers: { Cookie: `PVEAuthCookie=${cookie}` },
        rejectUnauthorized: false,
      });

      this.ws.binaryType = "arraybuffer";

      this.ws.on("open", () => {
        this.recvBuffer = Buffer.alloc(0);
        this.state = "awaiting_version";
      });

      this.ws.on("message", (data: ArrayBuffer | Buffer) => {
        try {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
          this.processReceiveBuffer();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (!settled) {
            fail(error);
          } else {
            console.error(`[VNC ${this.vmid}] post-handshake error:`, error.message);
          }
        }
      });

      this.once("_init_done", (width: number, height: number) => {
        succeed(width, height);
      });

      this.ws.on("error", (err) => {
        fail(err);
        this.emit("error", err);
      });

      this.ws.on("close", () => {
        const wasConnected = this._connected;
        this._connected = false;
        if (!wasConnected) {
          fail(new Error("WebSocket closed before handshake completed"));
        }
        this.emit("close");
      });
    });
  }

  private send(data: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private processReceiveBuffer(): void {
    // Keep processing as long as we have enough data
    let progress = true;
    while (progress) {
      progress = false;
      switch (this.state) {
        case "awaiting_version":
          progress = this.handleVersion();
          break;
        case "awaiting_security_types":
          progress = this.handleSecurityTypes();
          break;
        case "awaiting_vnc_challenge":
          progress = this.handleVncChallenge();
          break;
        case "awaiting_security_result":
          progress = this.handleSecurityResult();
          break;
        case "awaiting_server_init":
          progress = this.handleServerInit();
          break;
        case "connected":
          progress = this.handleServerMessage();
          break;
      }
    }
  }

  /**
   * Server sends "RFB 003.008\n" (12 bytes). We echo it back.
   */
  private handleVersion(): boolean {
    if (this.recvBuffer.length < 12) return false;

    const version = this.recvBuffer.subarray(0, 12).toString("ascii");
    this.recvBuffer = this.recvBuffer.subarray(12);

    if (!version.startsWith("RFB ")) {
      this.emit("error", new Error(`Unexpected RFB version: ${version.trim()}`));
      return false;
    }

    // Echo the same version
    this.send(Buffer.from("RFB 003.008\n", "ascii"));
    this.state = "awaiting_security_types";
    return true;
  }

  /**
   * Server lists security types. Through PVE proxy, expect type 1 (None).
   * Format: number-of-types (1 byte), then that many type bytes.
   */
  private handleSecurityTypes(): boolean {
    if (this.recvBuffer.length < 1) return false;

    const count = this.recvBuffer.readUInt8(0);

    if (count === 0) {
      // Server sent failure — next 4 bytes are reason length, then reason string
      if (this.recvBuffer.length < 5) return false;
      const reasonLen = this.recvBuffer.readUInt32BE(1);
      if (this.recvBuffer.length < 5 + reasonLen) return false;
      const reason = this.recvBuffer.subarray(5, 5 + reasonLen).toString("utf-8");
      this.recvBuffer = this.recvBuffer.subarray(5 + reasonLen);
      this.emit("error", new Error(`VNC authentication failed: ${reason}`));
      return false;
    }

    if (this.recvBuffer.length < 1 + count) return false;

    const types: number[] = [];
    for (let i = 0; i < count; i++) {
      types.push(this.recvBuffer.readUInt8(1 + i));
    }
    this.recvBuffer = this.recvBuffer.subarray(1 + count);

    // Prefer type 2 (VNC Authentication) which PVE uses, fall back to type 1 (None)
    if (types.includes(2)) {
      this.send(Buffer.from([2]));
      this.state = "awaiting_vnc_challenge";
    } else if (types.includes(1)) {
      this.send(Buffer.from([1]));
      this.state = "awaiting_security_result";
    } else {
      this.emit("error", new Error(`No supported VNC security type. Available: ${types.join(", ")}`));
      return false;
    }
    return true;
  }

  /**
   * VNC Authentication (type 2): server sends 16-byte challenge.
   * Client encrypts it with DES using the VNC password as key.
   */
  private handleVncChallenge(): boolean {
    if (this.recvBuffer.length < 16) return false;

    const challenge = Buffer.from(this.recvBuffer.subarray(0, 16));
    this.recvBuffer = this.recvBuffer.subarray(16);

    const response = vncDesEncrypt(this.vncPassword, challenge);
    this.send(response);
    this.state = "awaiting_security_result";
    return true;
  }

  /**
   * SecurityResult: 4 bytes, 0 = OK.
   */
  private handleSecurityResult(): boolean {
    if (this.recvBuffer.length < 4) return false;

    const result = this.recvBuffer.readUInt32BE(0);
    this.recvBuffer = this.recvBuffer.subarray(4);

    if (result !== 0) {
      this.emit("error", new Error(`VNC SecurityResult failed: ${result}`));
      return false;
    }

    // ClientInit: shared-flag = 1
    this.send(Buffer.from([1]));
    this.state = "awaiting_server_init";
    return true;
  }

  /**
   * ServerInit: width(2) + height(2) + pixel-format(16) + name-length(4) + name.
   */
  private handleServerInit(): boolean {
    if (this.recvBuffer.length < 24) return false;

    const width = this.recvBuffer.readUInt16BE(0);
    const height = this.recvBuffer.readUInt16BE(2);
    // Skip server pixel format (bytes 4-19), we'll set our own
    const nameLen = this.recvBuffer.readUInt32BE(20);

    if (this.recvBuffer.length < 24 + nameLen) return false;

    this.recvBuffer = this.recvBuffer.subarray(24 + nameLen);

    // Initialize framebuffer
    this.framebuffer = new Framebuffer(width, height);

    // Configure our pixel format and encodings
    this.send(buildSetPixelFormat());
    this.send(
      buildSetEncodings([
        RFB_ENCODING_COPYRECT,
        RFB_ENCODING_RAW,
        RFB_ENCODING_DESKTOP_SIZE,
        RFB_ENCODING_EXTENDED_KEY,
      ]),
    );

    // Request full framebuffer update
    this.send(buildFbUpdateRequest(false, 0, 0, width, height));

    this._connected = true;
    this.state = "connected";
    this.emit("_init_done", width, height);
    return true;
  }

  /**
   * Handle server messages once connected.
   */
  private handleServerMessage(): boolean {
    if (this.recvBuffer.length < 1) return false;

    const msgType = this.recvBuffer.readUInt8(0);

    switch (msgType) {
      case MSG_FB_UPDATE:
        return this.handleFramebufferUpdate();
      case MSG_SET_COLOUR_MAP:
        return this.handleSetColourMap();
      case MSG_BELL:
        this.recvBuffer = this.recvBuffer.subarray(1);
        return true;
      case MSG_SERVER_CUT_TEXT:
        return this.handleServerCutText();
      default:
        this.emit("error", new Error(`Unknown server message type: ${msgType}`));
        return false;
    }
  }

  /**
   * FramebufferUpdate: header(4) + N rectangles.
   * Header: type(1) + padding(1) + rect-count(2)
   * Rectangle: x(2) + y(2) + w(2) + h(2) + encoding(4) + data
   */
  private handleFramebufferUpdate(): boolean {
    if (this.recvBuffer.length < 4) return false;

    const rectCount = this.recvBuffer.readUInt16BE(2);
    let offset = 4;

    for (let i = 0; i < rectCount; i++) {
      if (this.recvBuffer.length < offset + 12) return false;

      const x = this.recvBuffer.readUInt16BE(offset);
      const y = this.recvBuffer.readUInt16BE(offset + 2);
      const w = this.recvBuffer.readUInt16BE(offset + 4);
      const h = this.recvBuffer.readUInt16BE(offset + 6);
      const encoding = this.recvBuffer.readInt32BE(offset + 8);
      offset += 12;

      switch (encoding) {
        case RFB_ENCODING_RAW: {
          const dataLen = w * h * 4; // 4 bytes per pixel
          if (this.recvBuffer.length < offset + dataLen) return false;
          this.framebuffer?.applyRaw(x, y, w, h, this.recvBuffer.subarray(offset, offset + dataLen));
          offset += dataLen;
          break;
        }

        case RFB_ENCODING_COPYRECT: {
          if (this.recvBuffer.length < offset + 4) return false;
          const srcX = this.recvBuffer.readUInt16BE(offset);
          const srcY = this.recvBuffer.readUInt16BE(offset + 2);
          this.framebuffer?.applyCopyRect(x, y, w, h, srcX, srcY);
          offset += 4;
          break;
        }

        case RFB_ENCODING_DESKTOP_SIZE: {
          // DesktopSize: the rectangle dimensions ARE the new size
          this.framebuffer?.resize(w, h);
          this.emit("resize", w, h);
          break;
        }

        case RFB_ENCODING_EXTENDED_KEY: {
          // Pseudo-encoding: server confirms Extended Key Event support
          this.supportsExtendedKey = true;
          break;
        }

        default:
          this.emit("error", new Error(`Unsupported encoding: ${encoding}`));
          return false;
      }
    }

    this.recvBuffer = this.recvBuffer.subarray(offset);

    // Request next incremental update
    if (this.framebuffer) {
      this.send(buildFbUpdateRequest(true, 0, 0, this.framebuffer.width, this.framebuffer.height));
    }

    this.emit("update");
    return true;
  }

  /**
   * SetColourMapEntries: type(1) + padding(1) + first-colour(2) + num-colours(2) + data.
   * We don't use indexed colour but must consume the message.
   */
  private handleSetColourMap(): boolean {
    if (this.recvBuffer.length < 6) return false;
    const numColours = this.recvBuffer.readUInt16BE(4);
    const totalLen = 6 + numColours * 6;
    if (this.recvBuffer.length < totalLen) return false;
    this.recvBuffer = this.recvBuffer.subarray(totalLen);
    return true;
  }

  /**
   * ServerCutText: type(1) + padding(3) + length(4) + text.
   */
  private handleServerCutText(): boolean {
    if (this.recvBuffer.length < 8) return false;
    const textLen = this.recvBuffer.readUInt32BE(4);
    const totalLen = 8 + textLen;
    if (this.recvBuffer.length < totalLen) return false;
    this.recvBuffer = this.recvBuffer.subarray(totalLen);
    return true;
  }

  // --- Input methods ---

  sendKeyEvent(down: boolean, keysym: number): void {
    this.send(buildKeyEvent(down, keysym));
  }

  sendPointerEvent(buttonMask: number, x: number, y: number): void {
    this.send(buildPointerEvent(buttonMask, x, y));
  }

  sendExtendedKeyEvent(down: boolean, keysym: number, scancode: number): void {
    if (this.supportsExtendedKey) {
      this.send(buildExtendedKeyEvent(down, keysym, scancode));
    } else {
      this.send(buildKeyEvent(down, keysym));
    }
  }

  /**
   * Type a string by sending key down+up for each character.
   */
  typeText(text: string): void {
    for (const char of text) {
      if (char === "\n") {
        this.sendKeyEvent(true, 0xff0d); // Return
        this.sendKeyEvent(false, 0xff0d);
        continue;
      }
      if (char === "\t") {
        this.sendKeyEvent(true, 0xff09); // Tab
        this.sendKeyEvent(false, 0xff09);
        continue;
      }

      const combo = SHIFTED_CHAR_COMBOS[char];
      if (combo) {
        const keysyms = parseKeyCombo(combo);
        for (const keysym of keysyms) this.sendKeyEvent(true, keysym);
        for (let i = keysyms.length - 1; i >= 0; i--) this.sendKeyEvent(false, keysyms[i]);
        continue;
      }

      const keysym = charToKeysym(char);
      this.sendKeyEvent(true, keysym);
      this.sendKeyEvent(false, keysym);
    }
  }

  /**
   * Press a key combo like "ctrl+c", "alt+tab", "Return".
   * Modifiers are held down, then key pressed, then all released in reverse order.
   */
  pressKey(combo: string): void {
    const keysyms = parseKeyCombo(combo);

    // Press all keys down in order
    for (const keysym of keysyms) {
      this.sendKeyEvent(true, keysym);
    }

    // Release in reverse order
    for (let i = keysyms.length - 1; i >= 0; i--) {
      this.sendKeyEvent(false, keysyms[i]);
    }
  }

  /**
   * Click at a position. Sends move → button down → button up.
   */
  click(x: number, y: number, button: "left" | "right" | "middle" = "left"): void {
    const buttonBit = button === "left" ? 1 : button === "middle" ? 2 : 4;
    this.sendPointerEvent(0, x, y); // move
    this.sendPointerEvent(buttonBit, x, y); // down
    this.sendPointerEvent(0, x, y); // up
  }

  /**
   * Scroll at a position.
   */
  scroll(x: number, y: number, direction: "up" | "down", amount: number = 3): void {
    const buttonBit = direction === "up" ? 8 : 16;
    for (let i = 0; i < amount; i++) {
      this.sendPointerEvent(buttonBit, x, y); // scroll press
      this.sendPointerEvent(0, x, y); // release
    }
  }

  /**
   * Drag from one point to another with animated intermediate steps.
   *
   * @param steps      Number of intermediate pointer events (default 20)
   * @param durationMs Total drag duration in milliseconds (default 500)
   * @param easing     Easing curve: "linear" | "ease-in" | "ease-out" | "ease-in-out" (default "ease-in-out")
   */
  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps: number = 20,
    durationMs: number = 500,
    easing: EasingType = "ease-in-out",
    startHoldMs: number = 50,
    endHoldMs: number = 50,
  ): Promise<void> {
    const delay = durationMs / steps;
    const ease = EASING_FUNCTIONS[easing];

    // Move to start position
    this.sendPointerEvent(0, fromX, fromY);
    if (startHoldMs > 0) await sleep(startHoldMs);

    // Press button down at start
    this.sendPointerEvent(1, fromX, fromY);
    if (startHoldMs > 0) await sleep(startHoldMs);

    // Interpolate through intermediate points with easing
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      const x = Math.round(fromX + (toX - fromX) * t);
      const y = Math.round(fromY + (toY - fromY) * t);
      this.sendPointerEvent(1, x, y);
      await sleep(delay);
    }

    // Small pause before release so the target registers the drop
    if (endHoldMs > 0) await sleep(endHoldMs);

    // Release button at destination
    this.sendPointerEvent(0, toX, toY);
  }

  /**
   * Request a fresh full framebuffer update.
   */
  requestFullUpdate(): void {
    if (this.framebuffer) {
      this.send(buildFbUpdateRequest(false, 0, 0, this.framebuffer.width, this.framebuffer.height));
    }
  }

  /**
   * Wait for at least one framebuffer update to arrive, or timeout.
   */
  waitForUpdate(timeoutMs: number = 3000): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.framebuffer?.dirty) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        this.removeListener("update", onUpdate);
        resolve();
      }, timeoutMs);
      timer.unref();

      const onUpdate = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("update", onUpdate);
    });
  }

  /**
   * Disconnect the VNC session.
   */
  disconnect(): void {
    this._connected = false;
    this.ws?.close();
    this.ws = null;
    this.recvBuffer = Buffer.alloc(0);
    this.state = "awaiting_version";
  }
}

/**
 * Manages multiple VNC sessions, one per VM.
 */
export class VncSessionManager {
  private sessions = new Map<number, VncSession>();
  private api: PveApiClient;

  constructor(api: PveApiClient) {
    this.api = api;
  }

  async connect(vmid: number, node?: string): Promise<VncSession> {
    // Disconnect existing session for this VM
    const existing = this.sessions.get(vmid);
    if (existing?.connected) {
      return existing;
    }
    if (existing) {
      existing.disconnect();
    }

    // Resolve node if not provided
    const resolvedNode = node ?? (await this.api.findVmNode(vmid));

    const session = new VncSession(this.api, { node: resolvedNode, vmid });
    this.sessions.set(vmid, session);

    await session.connect();
    return session;
  }

  getSession(vmid: number): VncSession | undefined {
    return this.sessions.get(vmid);
  }

  getConnectedSession(vmid: number): VncSession {
    const session = this.sessions.get(vmid);
    if (!session?.connected) {
      throw new Error(`No active VNC session for VM ${vmid}. Call connect first.`);
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
    for (const [vmid, session] of this.sessions) {
      session.disconnect();
      this.sessions.delete(vmid);
    }
  }
}
