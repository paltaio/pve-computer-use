/**
 * Screenshot & Coordinate Scaler
 *
 * Converts the RGBA framebuffer to JPEG for Claude's vision API.
 * Handles coordinate scaling between Claude's image coordinates and
 * the actual VM screen resolution.
 *
 * Claude vision constraints:
 * - Max 1568px on longest edge
 * - ~1.15 megapixels total
 * - Target ~1280x800 for good accuracy
 */

import sharp from "sharp";
import type { Framebuffer } from "./framebuffer.js";

export interface ScaledScreenshot {
  /** Base64-encoded JPEG image */
  data: string;
  /** Dimensions of the scaled image (what Claude sees) */
  scaledWidth: number;
  scaledHeight: number;
  /** Dimensions of the actual framebuffer */
  actualWidth: number;
  actualHeight: number;
  /** Scale factor: scaled/actual */
  scaleFactor: number;
}

/**
 * Calculate the optimal scale factor for Claude's vision API.
 *
 * Rules:
 * - Max 1568px longest edge
 * - Max ~1.15 megapixels
 * - Never upscale (factor <= 1.0)
 */
export function calculateScaleFactor(width: number, height: number): number {
  const maxEdge = 1568;
  const maxPixels = 1_150_000;

  const edgeFactor = maxEdge / Math.max(width, height);
  const pixelFactor = Math.sqrt(maxPixels / (width * height));

  return Math.min(1.0, edgeFactor, pixelFactor);
}

/**
 * Capture the current framebuffer as a JPEG screenshot.
 * The image is scaled to fit Claude's vision constraints.
 */
export async function captureScreenshot(fb: Framebuffer, quality: number = 75): Promise<ScaledScreenshot> {
  const actualWidth = fb.width;
  const actualHeight = fb.height;
  const scaleFactor = calculateScaleFactor(actualWidth, actualHeight);

  const scaledWidth = Math.round(actualWidth * scaleFactor);
  const scaledHeight = Math.round(actualHeight * scaleFactor);

  // Convert RGBA framebuffer to JPEG via sharp
  // PVE VNC pixel format: we configured BGRX (red-shift=16, green-shift=8, blue-shift=0)
  // The bytes in the framebuffer are: [B, G, R, A] for each pixel
  // sharp expects raw RGBA, so we need to swap R and B channels
  const rgbaBuffer = swapRedBlue(fb.buffer, actualWidth * actualHeight);

  let pipeline = sharp(rgbaBuffer, {
    raw: {
      width: actualWidth,
      height: actualHeight,
      channels: 4,
    },
  });

  if (scaleFactor < 1.0) {
    pipeline = pipeline.resize(scaledWidth, scaledHeight, {
      fit: "fill",
      kernel: "lanczos3",
    });
  }

  const jpegBuffer = await pipeline
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();

  return {
    data: jpegBuffer.toString("base64"),
    scaledWidth,
    scaledHeight,
    actualWidth,
    actualHeight,
    scaleFactor,
  };
}

/**
 * Swap R and B channels in a 4-byte-per-pixel buffer.
 * PVE VNC sends pixels as [B, G, R, X] but sharp expects [R, G, B, A].
 */
function swapRedBlue(buffer: Buffer, pixelCount: number): Buffer {
  const out = Buffer.from(buffer);
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    const b = out[offset];
    const r = out[offset + 2];
    out[offset] = r;
    out[offset + 2] = b;
    out[offset + 3] = 255; // ensure alpha is opaque
  }
  return out;
}

/**
 * Convert coordinates from Claude's scaled image space back to
 * actual framebuffer coordinates.
 */
export function scaleCoordinates(
  x: number,
  y: number,
  scaleFactor: number,
  actualWidth: number,
  actualHeight: number,
): { x: number; y: number } {
  return {
    x: Math.min(Math.round(x / scaleFactor), actualWidth - 1),
    y: Math.min(Math.round(y / scaleFactor), actualHeight - 1),
  };
}
