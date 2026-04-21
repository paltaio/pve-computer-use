import type { PveApiClient } from "./pve-api.js";

const POWERSHELL_EXE =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WSCRIPT_EXE = "C:\\Windows\\System32\\wscript.exe";
const DEFAULT_TASK_TIMEOUT_MS = 6000;
const DEFAULT_POST_RUN_DELAY_MS = 300;

function psSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function vbsEscapeDoubleQuote(value: string): string {
  return value.replace(/"/g, '""');
}

export function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

const isWindowsGuestCache = new Map<number, boolean>();

export async function isWindowsGuest(
  api: PveApiClient,
  node: string,
  vmid: number,
): Promise<boolean> {
  const cached = isWindowsGuestCache.get(vmid);
  if (cached !== undefined) return cached;
  try {
    const result = await api.guestExec(
      node,
      vmid,
      "C:\\Windows\\System32\\cmd.exe",
      ["/c", "ver"],
    );
    const detected = result.exitcode === 0;
    isWindowsGuestCache.set(vmid, detected);
    return detected;
  } catch {
    return false;
  }
}

/** Forget the cached OS detection for a VM (e.g. on disconnect or reboot). */
export function invalidateWindowsGuestCache(vmid?: number): void {
  if (vmid === undefined) {
    isWindowsGuestCache.clear();
  } else {
    isWindowsGuestCache.delete(vmid);
  }
}

export async function getActiveWindowsUsername(
  api: PveApiClient,
  node: string,
  vmid: number,
): Promise<string> {
  const result = await api.guestExec(
    node,
    vmid,
    "C:\\Windows\\System32\\cmd.exe",
    ["/c", "query user"],
  );
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const raw of lines) {
    const line = raw.replace(/^>/, "").trim();
    if (!/\bActive\b/i.test(line)) continue;
    const m = line.match(/^(\S+)/);
    if (m?.[1]) return m[1];
  }

  throw new Error(
    `Could not find an Active desktop user (query user). exit=${result.exitcode} stderr=${result.stderr || ""}`.trim(),
  );
}

export async function writeWindowsUtf16File(
  api: PveApiClient,
  node: string,
  vmid: number,
  path: string,
  content: string,
): Promise<void> {
  const b64 = Buffer.from(content, "utf16le").toString("base64");
  const command = `[IO.File]::WriteAllText('${psSingleQuoted(path)}', [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}')), [Text.Encoding]::Unicode)`;
  const result = await api.guestExec(node, vmid, POWERSHELL_EXE, [
    "-NoProfile",
    "-Command",
    command,
  ]);
  if (result.exitcode !== 0) {
    throw new Error(`WriteAllText failed: ${result.stderr || "unknown error"}`);
  }
}

export async function removeWindowsFile(
  api: PveApiClient,
  node: string,
  vmid: number,
  path: string,
): Promise<void> {
  await api.guestExec(node, vmid, "C:\\Windows\\System32\\cmd.exe", [
    "/c",
    "del",
    "/f",
    "/q",
    path,
  ]);
}

export interface InteractiveUserActionOptions {
  taskName: string;
  /** The exact string passed to schtasks /tr. Caller handles quoting of exe+args. */
  taskCommand: string;
  /** If true, the orchestrator waits inside the guest for task completion. */
  waitForCompletion: boolean;
  /** Timeout for in-guest wait. Defaults to DEFAULT_TASK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Fire-and-forget only: delay before the orchestrator deletes the task. */
  postRunDelayMs?: number;
  /**
   * Optional UTF-16 file written by the orchestrator before registering the
   * task and deleted in `finally`. Use for tiny wrapper scripts (e.g. a VBS
   * launcher) without paying for extra exec_command round trips.
   */
  setupFile?: {
    path: string;
    content: string;
  };
}

/**
 * Run a command in the active user's desktop session via one exec_command.
 *
 * Sends a single PowerShell orchestrator that resolves the console user,
 * creates the interactive schtasks entry, runs it, optionally waits for
 * completion, and deletes the task — all inside the guest. If `setupFile`
 * is provided, the same orchestrator writes and deletes it in try/finally,
 * so the entire operation stays as one host↔guest round trip.
 */
export async function runInteractiveUserAction(
  api: PveApiClient,
  node: string,
  vmid: number,
  opts: InteractiveUserActionOptions,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const postRunDelayMs = opts.postRunDelayMs ?? DEFAULT_POST_RUN_DELAY_MS;
  const script = buildOrchestratorScript({
    taskName: opts.taskName,
    taskCommand: opts.taskCommand,
    waitForCompletion: opts.waitForCompletion,
    timeoutMs,
    postRunDelayMs,
    setupFile: opts.setupFile,
  });
  const encoded = encodePowerShellCommand(script);
  const result = await api.guestExec(node, vmid, POWERSHELL_EXE, [
    "-NoProfile",
    "-STA",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ]);
  if (result.exitcode !== 0) {
    throw new Error(
      `interactive user action failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
}

function buildOrchestratorScript(params: {
  taskName: string;
  taskCommand: string;
  waitForCompletion: boolean;
  timeoutMs: number;
  postRunDelayMs: number;
  setupFile?: { path: string; content: string };
}): string {
  const tn = psSingleQuoted(params.taskName);
  const tr = psSingleQuoted(params.taskCommand);
  const wait = params.waitForCompletion ? "$true" : "$false";

  const setupFileLines: string[] = [];
  const setupCleanupLines: string[] = [];
  if (params.setupFile) {
    const filePath = psSingleQuoted(params.setupFile.path);
    const contentB64 = Buffer.from(
      params.setupFile.content,
      "utf16le",
    ).toString("base64");
    setupFileLines.push(
      `$setupPath = '${filePath}'`,
      `[IO.File]::WriteAllText($setupPath, [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${contentB64}')), [Text.Encoding]::Unicode)`,
    );
    setupCleanupLines.push(
      "  if ($setupPath) { Remove-Item -LiteralPath $setupPath -Force -ErrorAction SilentlyContinue }",
    );
  }

  return [
    "$ErrorActionPreference = 'Stop'",
    `$taskName = '${tn}'`,
    `$tr = '${tr}'`,
    `$wait = ${wait}`,
    `$timeoutMs = ${params.timeoutMs}`,
    `$postDelayMs = ${params.postRunDelayMs}`,
    "$cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue",
    "$u = if ($cs) { $cs.UserName } else { $null }",
    "if ($u -and $u -match '\\\\') { $u = ($u -split '\\\\')[1] }",
    "if (-not $u) {",
    "  $raw = & query user 2>$null",
    "  if ($raw) {",
    "    foreach ($line in $raw) {",
    "      $clean = ($line -replace '^>','').Trim()",
    "      if ($clean -match '^(\\S+)\\s+.*\\bActive\\b') { $u = $Matches[1]; break }",
    "    }",
    "  }",
    "}",
    "if (-not $u) { throw 'No active desktop user' }",
    ...setupFileLines,
    "try {",
    "  & schtasks /create /tn $taskName /tr $tr /sc once /st 00:00 /ru $u /it /f | Out-Null",
    "  & schtasks /run /tn $taskName | Out-Null",
    "  if ($wait) {",
    "    $deadline = (Get-Date).AddMilliseconds($timeoutMs)",
    "    while ((Get-Date) -lt $deadline) {",
    "      $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop",
    "      $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop",
    "      if ($t.State -ne 'Running') {",
    "        $r = [int]$info.LastTaskResult",
    "        if ($r -eq 0) { break }",
    "        if ($r -ne 267011) { throw \"task failed: state=$($t.State) result=$r\" }",
    "      }",
    "      Start-Sleep -Milliseconds 100",
    "    }",
    "  } elseif ($postDelayMs -gt 0) {",
    "    Start-Sleep -Milliseconds $postDelayMs",
    "  }",
    "} finally {",
    "  & schtasks /delete /tn $taskName /f 2>$null | Out-Null",
    ...setupCleanupLines,
    "}",
  ].join("; ");
}

/**
 * Build a VBS launcher that runs a Windows command with no visible console.
 *
 * wscript.exe is a Windows-subsystem binary (no console attached). Its
 * WScript.Shell.Run with windowStyle=0 launches the child process with
 * SW_HIDE set from process creation, so no console/window ever becomes
 * foreground — avoiding the blur/focus event burst that
 * `powershell -WindowStyle Hidden` triggers on web forms.
 */
function buildHiddenVbsLauncher(command: string, waitForChild: boolean): string {
  const waitFlag = waitForChild ? "True" : "False";
  return [
    `CreateObject("WScript.Shell").Run "${vbsEscapeDoubleQuote(command)}", 0, ${waitFlag}`,
    "",
  ].join("\r\n");
}

/**
 * Set the Windows clipboard to `text` via the active user's desktop session.
 * Expects the caller to then emit Ctrl+V over VNC.
 *
 * The user's PowerShell runs inside a wscript-hosted child so no console
 * window ever attaches. The target app never sees a blur/focus event.
 */
export async function typeTextWindowsClipboard(
  api: PveApiClient,
  node: string,
  vmid: number,
  text: string,
): Promise<void> {
  const taskName = `McpSetClipboard_${vmid}_${Date.now()}`;
  const vbsPath = `C:\\Users\\Public\\Documents\\${taskName}.vbs`;
  const textB64 = Buffer.from(text, "utf16le").toString("base64");
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    `$t = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${textB64}'))`,
    "Set-Clipboard -Value $t",
  ].join("; ");
  const psCommand = `${POWERSHELL_EXE} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(psScript)}`;
  const vbsBody = buildHiddenVbsLauncher(psCommand, true);

  await runInteractiveUserAction(api, node, vmid, {
    taskName,
    taskCommand: `${WSCRIPT_EXE} "${vbsPath}"`,
    waitForCompletion: true,
    setupFile: { path: vbsPath, content: vbsBody },
  });
}
