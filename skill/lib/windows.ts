/**
 * Windows guest helpers. Thin wrappers around `vm.guest.exec` for the patterns
 * that come up in every Windows automation script: running PowerShell without
 * quoting hell, running a one-line cmd, writing/reading files, downloading.
 */

import type { Vm } from './index.js'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

export interface ExecOptions {
	timeoutMs?: number
}

export interface ExecResult {
	exitcode: number
	stdout: string
	stderr: string
}

/** Escape a value for single-quoted PowerShell strings. */
export function psEscape(value: string): string {
	return value.replace(/'/g, "''")
}

/** UTF-16 + base64 encode a script for `powershell -EncodedCommand`. */
export function encodePs(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Run a PowerShell script via -EncodedCommand. Sidesteps cmd/PS quoting:
 * pass any script as a string, including embedded quotes and pipes.
 */
export function ps(vm: Vm, script: string, opts: ExecOptions = {}): Promise<ExecResult> {
	return vm.guest.exec(
		POWERSHELL,
		[
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
			encodePs(script),
		],
		opts,
	)
}

/** Run a single `cmd.exe /c` line. Caller handles cmd quoting. */
export function cmd(vm: Vm, line: string, opts: ExecOptions = {}): Promise<ExecResult> {
	return vm.guest.exec(CMD, ['/c', line], opts)
}

/** Username of the active console session (without domain). */
export async function activeUser(vm: Vm): Promise<string> {
	const r = await ps(
		vm,
		'$u = (Get-CimInstance Win32_ComputerSystem).UserName; if ($u) { ($u -split "\\\\")[-1] }',
	)
	const u = r.stdout.trim()
	if (!u) throw new Error('no active desktop user')
	return u
}

/** Write text to a file in the guest. UTF-8 by default. */
export async function writeFile(
	vm: Vm,
	path: string,
	content: string,
	opts: { encoding?: 'utf8' | 'utf16' | 'ascii' } & ExecOptions = {},
): Promise<void> {
	const enc = opts.encoding ?? 'utf8'
	const buf = enc === 'utf16' ? Buffer.from(content, 'utf16le') : Buffer.from(content, enc)
	const b64 = buf.toString('base64')
	// Stock `[Text.Encoding]::UTF8` emits a BOM; instantiate one explicitly to
	// suppress it so files round-trip byte-for-byte.
	const psEnc =
		enc === 'utf16'
			? '[Text.Encoding]::Unicode'
			: enc === 'ascii'
				? '[Text.Encoding]::ASCII'
				: '(New-Object System.Text.UTF8Encoding $false)'
	const script = [
		"$ErrorActionPreference='Stop'",
		`$enc=${psEnc}`,
		`$b=[Convert]::FromBase64String('${b64}')`,
		`[IO.File]::WriteAllText('${psEscape(path)}',$enc.GetString($b),$enc)`,
	].join('; ')
	const r = await ps(vm, script, opts)
	if (r.exitcode !== 0) throw new Error(`writeFile failed: ${r.stderr || r.stdout}`)
}

/**
 * Read a UTF-8 text file from the guest. The file bytes are base64-encoded
 * inside PowerShell so they survive the console output code page (which is
 * not UTF-8 by default on most Windows installs).
 */
export async function readFile(vm: Vm, path: string, opts: ExecOptions = {}): Promise<string> {
	const r = await ps(vm, `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${psEscape(path)}'))`, opts)
	if (r.exitcode !== 0) throw new Error(`readFile failed: ${r.stderr || r.stdout}`)
	const text = Buffer.from(r.stdout.trim(), 'base64').toString('utf8')
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Download `url` to `dest` via Invoke-WebRequest. */
export async function download(
	vm: Vm,
	url: string,
	dest: string,
	opts: ExecOptions = {},
): Promise<void> {
	const script = [
		"$ErrorActionPreference='Stop'",
		"$ProgressPreference='SilentlyContinue'",
		`Invoke-WebRequest -UseBasicParsing -Uri '${psEscape(url)}' -OutFile '${psEscape(dest)}'`,
	].join('; ')
	const r = await ps(vm, script, opts)
	if (r.exitcode !== 0) throw new Error(`download failed: ${r.stderr || r.stdout}`)
}

/** Force an immediate reboot. */
export function reboot(vm: Vm): Promise<ExecResult> {
	return cmd(vm, 'shutdown /r /t 0 /f')
}

/** Power off the guest. */
export function shutdown(vm: Vm): Promise<ExecResult> {
	return cmd(vm, 'shutdown /s /t 0 /f')
}
