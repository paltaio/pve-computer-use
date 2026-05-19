/**
 * Linux guest helpers. Wrappers around `vm.guest.exec` for shell, file I/O,
 * systemctl, and downloads.
 */

import type { Vm } from './index.js'

export interface ExecOptions {
	timeoutMs?: number
}

export interface ExecResult {
	exitcode: number
	stdout: string
	stderr: string
}

/** POSIX single-quote escape: wraps in '...' and escapes embedded quotes. */
export function shEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Run a command line via `bash -lc`. */
export function sh(vm: Vm, line: string, opts: ExecOptions = {}): Promise<ExecResult> {
	return vm.guest.exec('/bin/bash', ['-lc', line], opts)
}

/** Run a command via `sudo -n` (passwordless). */
export function sudo(vm: Vm, line: string, opts: ExecOptions = {}): Promise<ExecResult> {
	return vm.guest.exec('/usr/bin/sudo', ['-n', '/bin/bash', '-lc', line], opts)
}

/** Write `content` to `path`. Goes through base64+tee so binary is safe. */
export async function writeFile(
	vm: Vm,
	path: string,
	content: string | Buffer,
	opts: { mode?: string; sudo?: boolean } & ExecOptions = {},
): Promise<void> {
	const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
	const b64 = buf.toString('base64')
	const writer = opts.sudo ? 'sudo tee' : 'tee'
	const line = `printf %s ${shEscape(b64)} | base64 -d | ${writer} ${shEscape(path)} > /dev/null`
	const r = await sh(vm, line, opts)
	if (r.exitcode !== 0) throw new Error(`writeFile failed: ${r.stderr || r.stdout}`)
	if (opts.mode) {
		const chmod = `${opts.sudo ? 'sudo ' : ''}chmod ${opts.mode} ${shEscape(path)}`
		await sh(vm, chmod, opts)
	}
}

/** Read a UTF-8 text file. */
export async function readFile(vm: Vm, path: string, opts: ExecOptions = {}): Promise<string> {
	const r = await sh(vm, `cat ${shEscape(path)}`, opts)
	if (r.exitcode !== 0) throw new Error(`readFile failed: ${r.stderr || r.stdout}`)
	return r.stdout
}

/** `systemctl(vm, 'restart', 'sshd')` */
export function systemctl(vm: Vm, ...args: string[]): Promise<ExecResult> {
	return vm.guest.exec('/usr/bin/systemctl', args)
}

/** Download `url` to `dest` via curl. */
export async function download(
	vm: Vm,
	url: string,
	dest: string,
	opts: ExecOptions = {},
): Promise<void> {
	const r = await sh(vm, `curl -fLsS ${shEscape(url)} -o ${shEscape(dest)}`, opts)
	if (r.exitcode !== 0) throw new Error(`download failed: ${r.stderr || r.stdout}`)
}

/** Force an immediate reboot (tries direct then sudo). */
export function reboot(vm: Vm): Promise<ExecResult> {
	return sh(vm, 'reboot 2>/dev/null || sudo -n reboot')
}

export function shutdown(vm: Vm): Promise<ExecResult> {
	return sh(vm, 'shutdown -h now 2>/dev/null || sudo -n shutdown -h now')
}
