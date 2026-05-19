/**
 * macOS guest helpers. Wrappers around `vm.guest.exec` for zsh, AppleScript,
 * file I/O, and downloads.
 */

import type { Vm } from './index.js'
import { shEscape } from './linux.js'

export { shEscape }

export interface ExecOptions {
	timeoutMs?: number
}

export interface ExecResult {
	exitcode: number
	stdout: string
	stderr: string
}

/** Run a command line via `zsh -lc`. */
export function sh(vm: Vm, line: string, opts: ExecOptions = {}): Promise<ExecResult> {
	return vm.guest.exec('/bin/zsh', ['-lc', line], opts)
}

/** Run a command via `sudo -n` (passwordless). */
export function sudo(vm: Vm, line: string, opts: ExecOptions = {}): Promise<ExecResult> {
	return vm.guest.exec('/usr/bin/sudo', ['-n', '/bin/zsh', '-lc', line], opts)
}

/** Evaluate an AppleScript expression. */
export function osascript(vm: Vm, script: string, opts: ExecOptions = {}): Promise<ExecResult> {
	return vm.guest.exec('/usr/bin/osascript', ['-e', script], opts)
}

/** Write `content` to `path` via base64 + tee. */
export async function writeFile(
	vm: Vm,
	path: string,
	content: string | Buffer,
	opts: { mode?: string; sudo?: boolean } & ExecOptions = {},
): Promise<void> {
	const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
	const b64 = buf.toString('base64')
	const writer = opts.sudo ? 'sudo tee' : 'tee'
	// macOS base64 uses -D, not -d.
	const line = `printf %s ${shEscape(b64)} | /usr/bin/base64 -D | ${writer} ${shEscape(path)} > /dev/null`
	const r = await sh(vm, line, opts)
	if (r.exitcode !== 0) throw new Error(`writeFile failed: ${r.stderr || r.stdout}`)
	if (opts.mode) {
		const chmod = `${opts.sudo ? 'sudo ' : ''}chmod ${opts.mode} ${shEscape(path)}`
		await sh(vm, chmod, opts)
	}
}

export async function readFile(vm: Vm, path: string, opts: ExecOptions = {}): Promise<string> {
	const r = await sh(vm, `cat ${shEscape(path)}`, opts)
	if (r.exitcode !== 0) throw new Error(`readFile failed: ${r.stderr || r.stdout}`)
	return r.stdout
}

export async function download(
	vm: Vm,
	url: string,
	dest: string,
	opts: ExecOptions = {},
): Promise<void> {
	const r = await sh(vm, `curl -fLsS ${shEscape(url)} -o ${shEscape(dest)}`, opts)
	if (r.exitcode !== 0) throw new Error(`download failed: ${r.stderr || r.stdout}`)
}

export function reboot(vm: Vm): Promise<ExecResult> {
	return sh(vm, 'sudo -n shutdown -r now')
}

export function shutdown(vm: Vm): Promise<ExecResult> {
	return sh(vm, 'sudo -n shutdown -h now')
}
