/**
 * RFB (Remote Framebuffer) Protocol Constants and Helpers
 *
 * Implements the subset of RFB 3.8 needed for PVE VNC:
 * - Security type 1 (None) — PVE authenticates via ticket
 * - RAW + CopyRect encodings
 * - DesktopSize pseudo-encoding
 * - KeyEvent, PointerEvent, FramebufferUpdateRequest
 */

// --- Encodings ---

export const RFB_ENCODING_RAW = 0;
export const RFB_ENCODING_COPYRECT = 1;
export const RFB_ENCODING_DESKTOP_SIZE = -223;
export const RFB_ENCODING_EXTENDED_KEY = -258;

// --- Client→Server message types ---

export const MSG_SET_PIXEL_FORMAT = 0;
export const MSG_SET_ENCODINGS = 2;
export const MSG_FB_UPDATE_REQUEST = 3;
export const MSG_KEY_EVENT = 4;
export const MSG_POINTER_EVENT = 5;
export const MSG_EXTENDED_KEY_EVENT = 255;

// --- Server→Client message types ---

export const MSG_FB_UPDATE = 0;
export const MSG_SET_COLOUR_MAP = 1;
export const MSG_BELL = 2;
export const MSG_SERVER_CUT_TEXT = 3;

// --- Pixel format: 32-bit RGBA, little-endian ---

export const PIXEL_FORMAT = Buffer.from([
  32,       // bits-per-pixel
  24,       // depth
  0,        // big-endian-flag (little-endian)
  1,        // true-colour-flag
  0, 255,   // red-max (255)
  0, 255,   // green-max (255)
  0, 255,   // blue-max (255)
  16,       // red-shift
  8,        // green-shift
  0,        // blue-shift
  0, 0, 0,  // padding
]);

/**
 * Build SetPixelFormat message (type 0, 20 bytes).
 */
export function buildSetPixelFormat(): Buffer {
  const buf = Buffer.alloc(20);
  buf.writeUInt8(MSG_SET_PIXEL_FORMAT, 0);
  // 3 bytes padding (1-3)
  PIXEL_FORMAT.copy(buf, 4);
  return buf;
}

/**
 * Build SetEncodings message (type 2).
 */
export function buildSetEncodings(encodings: number[]): Buffer {
  const buf = Buffer.alloc(4 + encodings.length * 4);
  buf.writeUInt8(MSG_SET_ENCODINGS, 0);
  // 1 byte padding
  buf.writeUInt16BE(encodings.length, 2);
  for (let i = 0; i < encodings.length; i++) {
    buf.writeInt32BE(encodings[i], 4 + i * 4);
  }
  return buf;
}

/**
 * Build FramebufferUpdateRequest (type 3, 10 bytes).
 */
export function buildFbUpdateRequest(incremental: boolean, x: number, y: number, w: number, h: number): Buffer {
  const buf = Buffer.alloc(10);
  buf.writeUInt8(MSG_FB_UPDATE_REQUEST, 0);
  buf.writeUInt8(incremental ? 1 : 0, 1);
  buf.writeUInt16BE(x, 2);
  buf.writeUInt16BE(y, 4);
  buf.writeUInt16BE(w, 6);
  buf.writeUInt16BE(h, 8);
  return buf;
}

/**
 * Build KeyEvent message (type 4, 8 bytes).
 */
export function buildKeyEvent(down: boolean, keysym: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(MSG_KEY_EVENT, 0);
  buf.writeUInt8(down ? 1 : 0, 1);
  // 2 bytes padding
  buf.writeUInt32BE(keysym, 4);
  return buf;
}

/**
 * Build PointerEvent message (type 5, 6 bytes).
 */
export function buildPointerEvent(buttonMask: number, x: number, y: number): Buffer {
  const buf = Buffer.alloc(6);
  buf.writeUInt8(MSG_POINTER_EVENT, 0);
  buf.writeUInt8(buttonMask, 1);
  buf.writeUInt16BE(x, 2);
  buf.writeUInt16BE(y, 4);
  return buf;
}

/**
 * Build QEMU Extended Key Event message (type 255, 12 bytes).
 * Sends XT scancode alongside keysym for unambiguous keyboard mapping.
 */
export function buildExtendedKeyEvent(down: boolean, keysym: number, scancode: number): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt8(MSG_EXTENDED_KEY_EVENT, 0);
  // 1 byte sub-message-type: 0 = QEMU extended key event
  buf.writeUInt8(0, 1);
  buf.writeUInt16BE(down ? 1 : 0, 2);
  buf.writeUInt32BE(keysym, 4);
  buf.writeUInt32BE(scancode, 8);
  return buf;
}

// --- Keysym mappings ---

export const SPECIAL_KEYS: Record<string, number> = {
  return: 0xff0d,
  enter: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  backspace: 0xff08,
  tab: 0xff09,
  space: 0x0020,
  delete: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  f1: 0xffbe,
  f2: 0xffbf,
  f3: 0xffc0,
  f4: 0xffc1,
  f5: 0xffc2,
  f6: 0xffc3,
  f7: 0xffc4,
  f8: 0xffc5,
  f9: 0xffc6,
  f10: 0xffc7,
  f11: 0xffc8,
  f12: 0xffc9,
  shift: 0xffe1,
  shift_l: 0xffe1,
  shift_r: 0xffe2,
  ctrl: 0xffe3,
  control: 0xffe3,
  control_l: 0xffe3,
  control_r: 0xffe4,
  alt: 0xffe9,
  alt_l: 0xffe9,
  alt_r: 0xffea,
  super: 0xffeb,
  super_l: 0xffeb,
  super_r: 0xffec,
  // Map "meta" to Windows/Super for practical automation on Windows guests.
  meta: 0xffeb,
  meta_l: 0xffeb,
  meta_r: 0xffec,
  capslock: 0xffe5,
  numlock: 0xff7f,
  scrolllock: 0xff14,
  printscreen: 0xff61,
  pause: 0xff13,
  menu: 0xff67,
};

/**
 * Convert a character or key name to an X11 keysym.
 * Printable ASCII maps directly to its codepoint.
 */
export function charToKeysym(char: string): number {
  const lower = char.toLowerCase();
  if (SPECIAL_KEYS[lower] !== undefined) {
    return SPECIAL_KEYS[lower];
  }

  // Single printable character → Unicode codepoint (works for Latin-1)
  if (char.length === 1) {
    const code = char.charCodeAt(0);
    // ASCII printable range maps directly
    if (code >= 0x20 && code <= 0x7e) {
      return code;
    }
    // Latin-1 supplement (0x80-0xFF) maps directly
    if (code >= 0xa0 && code <= 0xff) {
      return code;
    }
    // Unicode BMP: keysym = 0x01000000 + codepoint
    if (code > 0xff) {
      return 0x01000000 + code;
    }
  }

  throw new Error(`Unknown key: "${char}"`);
}

/**
 * Parse a key combo string like "ctrl+c", "alt+tab", "shift+a" into
 * an array of keysyms. Modifiers come first.
 */
export function parseKeyCombo(combo: string): number[] {
  const parts = combo.toLowerCase().split("+");
  return parts.map((part) => {
    const trimmed = part.trim();
    if (SPECIAL_KEYS[trimmed] !== undefined) {
      return SPECIAL_KEYS[trimmed];
    }
    return charToKeysym(trimmed);
  });
}
