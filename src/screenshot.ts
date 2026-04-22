/**
 * Screenshot capture
 *
 * Converts the RGBA framebuffer to JPEG at native resolution.
 */

import sharp from 'sharp'
import type { Framebuffer } from './framebuffer.js'

export interface Screenshot {
	/** Base64-encoded JPEG image */
	data: string
	/** Image dimensions */
	width: number
	height: number
}

/**
 * Capture the current framebuffer as a JPEG screenshot at native resolution.
 */
export async function captureScreenshot(
	fb: Framebuffer,
	quality: number = 85,
): Promise<Screenshot> {
	const { width, height } = fb

	// PVE VNC pixel format: BGRX (red-shift=16, green-shift=8, blue-shift=0)
	// sharp expects RGBA, so swap R and B channels
	const rgbaBuffer = swapRedBlue(fb.buffer, width * height)

	const jpegBuffer = await sharp(rgbaBuffer, {
		raw: { width, height, channels: 4 },
	})
		.jpeg({ quality, mozjpeg: true })
		.toBuffer()

	return {
		data: jpegBuffer.toString('base64'),
		width,
		height,
	}
}

/**
 * Swap R and B channels in a 4-byte-per-pixel buffer.
 * PVE VNC sends pixels as [B, G, R, X] but sharp expects [R, G, B, A].
 */
function swapRedBlue(buffer: Buffer, pixelCount: number): Buffer {
	const out = Buffer.from(buffer)
	for (let i = 0; i < pixelCount; i++) {
		const offset = i * 4
		const b = out[offset]
		const r = out[offset + 2]
		out[offset] = r
		out[offset + 2] = b
		out[offset + 3] = 255 // ensure alpha is opaque
	}
	return out
}
