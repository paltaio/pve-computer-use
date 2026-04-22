/**
 * VNC DES authentication helper.
 *
 * VNC auth (security type 2) requires DES-ECB encryption of a 16-byte
 * challenge with the password as key. OpenSSL 3.x disables DES by default,
 * so we use des.js (pure JS implementation) to avoid the legacy provider flag.
 *
 * VNC quirk: each byte of the key has its bits reversed (LSB first).
 */

// @ts-expect-error des.js has no type declarations
import DES from 'des.js'

function reverseBits(b: number): number {
	let r = 0
	for (let i = 0; i < 8; i++) {
		r = (r << 1) | (b & 1)
		b >>= 1
	}
	return r
}

/**
 * Encrypt a VNC challenge using DES-ECB.
 * Password is truncated/padded to 8 bytes, bits reversed per byte.
 * Challenge is 16 bytes, encrypted as two 8-byte blocks.
 */
export function vncDesEncrypt(password: string, challenge: Buffer): Buffer {
	const keyBuf = Buffer.alloc(8)
	Buffer.from(password, 'ascii').copy(keyBuf, 0, 0, Math.min(8, password.length))

	// VNC reverses bits in each key byte
	const key = Buffer.alloc(8)
	for (let i = 0; i < 8; i++) {
		key[i] = reverseBits(keyBuf[i])
	}

	const cipher = DES.DES.create({ type: 'encrypt', key: [...key] })

	const block1 = Buffer.from(cipher.update([...challenge.subarray(0, 8)]))
	const block2 = Buffer.from(cipher.update([...challenge.subarray(8, 16)]))

	return Buffer.concat([block1, block2])
}
