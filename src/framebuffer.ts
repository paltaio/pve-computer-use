/**
 * Framebuffer Manager
 *
 * In-memory RGBA framebuffer that receives FramebufferUpdate rectangles
 * from the VNC server and maintains a current screen image.
 *
 * Supports:
 * - RAW encoding (pixel dump)
 * - CopyRect encoding (blit from own buffer)
 * - DesktopSize pseudo-encoding (resolution change)
 */

export class Framebuffer {
	private _width: number
	private _height: number
	/** RGBA pixel data, 4 bytes per pixel */
	private _buffer: Buffer
	private _dirty = false

	constructor(width: number, height: number) {
		this._width = width
		this._height = height
		this._buffer = Buffer.alloc(width * height * 4)
	}

	get width(): number {
		return this._width
	}

	get height(): number {
		return this._height
	}

	get buffer(): Buffer {
		return this._buffer
	}

	get dirty(): boolean {
		return this._dirty
	}

	markClean(): void {
		this._dirty = false
	}

	/**
	 * Apply a RAW-encoded rectangle.
	 * Pixels are 4 bytes each (as configured in our pixel format).
	 */
	applyRaw(x: number, y: number, w: number, h: number, data: Buffer): void {
		const bpp = 4
		const stride = this._width * bpp

		for (let row = 0; row < h; row++) {
			const srcOffset = row * w * bpp
			const dstOffset = (y + row) * stride + x * bpp
			data.copy(this._buffer, dstOffset, srcOffset, srcOffset + w * bpp)
		}

		this._dirty = true
	}

	/**
	 * Apply a CopyRect-encoded rectangle.
	 * Copies pixels from (srcX, srcY) within our own buffer to (dstX, dstY).
	 */
	applyCopyRect(
		dstX: number,
		dstY: number,
		w: number,
		h: number,
		srcX: number,
		srcY: number,
	): void {
		const bpp = 4
		const stride = this._width * bpp

		// Must handle overlapping copies correctly
		if (srcY < dstY || (srcY === dstY && srcX < dstX)) {
			// Copy bottom-to-top to avoid overwriting source
			for (let row = h - 1; row >= 0; row--) {
				const src = (srcY + row) * stride + srcX * bpp
				const dst = (dstY + row) * stride + dstX * bpp
				this._buffer.copy(this._buffer, dst, src, src + w * bpp)
			}
		} else {
			for (let row = 0; row < h; row++) {
				const src = (srcY + row) * stride + srcX * bpp
				const dst = (dstY + row) * stride + dstX * bpp
				this._buffer.copy(this._buffer, dst, src, src + w * bpp)
			}
		}

		this._dirty = true
	}

	/**
	 * Handle DesktopSize pseudo-encoding: resize the framebuffer.
	 */
	resize(newWidth: number, newHeight: number): void {
		this._width = newWidth
		this._height = newHeight
		this._buffer = Buffer.alloc(newWidth * newHeight * 4)
		this._dirty = true
	}
}
