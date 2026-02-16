#!/usr/bin/env node

/**
 * PVE Computer Use MCP Server
 *
 * MCP server that lets AI agents see and control Proxmox VE virtual machine
 * displays via VNC. Screenshot, click, type, scroll — computer use for VMs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import { PveAuthManager, loadCredentialsFromEnv } from "./pve-auth.js";
import { PveApiClient } from "./pve-api.js";
import { VncSessionManager } from "./vnc-session.js";
import { captureScreenshot, scaleCoordinates, calculateScaleFactor } from "./screenshot.js";
import { destroyDispatchers } from "./http.js";

// --- State ---

let auth: PveAuthManager;
let api: PveApiClient;
let sessions: VncSessionManager;

/** Track the last scale factor per VM for coordinate scaling */
const lastScaleFactors = new Map<number, number>();

/** Track active vmid for single-session convenience */
let activeVmid: number | null = null;

function resolveVmid(vmid?: number): number {
  if (vmid !== undefined) return vmid;
  if (activeVmid !== null) return activeVmid;
  throw new Error("No vmid provided and no active session. Call connect first.");
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "pve-computer-use",
  version: "0.1.0",
});

// --- Tool: connect ---

server.registerTool("connect", {
  title: "Connect to VM",
  description: "Connect to a Proxmox VE virtual machine's display via VNC. Must be called before other tools.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID (e.g. 100)"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const session = await sessions.connect(vmid, node);
  const fb = session.screen;
  activeVmid = vmid;

  return {
    content: [{
      type: "text" as const,
      text: `Connected to VM ${vmid} on node ${session.node}. Screen size: ${fb?.width}x${fb?.height}`,
    }],
  };
});

// --- Tool: screenshot ---

server.registerTool("screenshot", {
  title: "Screenshot",
  description: "Capture a screenshot of the VM's current display. Returns a JPEG image.",
  inputSchema: {
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);

  // Request a fresh full update and wait for it
  session.requestFullUpdate();
  await session.waitForUpdate(3000);

  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const screenshot = await captureScreenshot(fb);
  lastScaleFactors.set(id, screenshot.scaleFactor);

  return {
    content: [{
      type: "image" as const,
      data: screenshot.data,
      mimeType: "image/jpeg" as const,
    }, {
      type: "text" as const,
      text: `Screenshot: ${screenshot.actualWidth}x${screenshot.actualHeight} → ${screenshot.scaledWidth}x${screenshot.scaledHeight} (scale: ${screenshot.scaleFactor.toFixed(3)})`,
    }],
  };
});

// --- Tool: mouse_click ---

server.registerTool("mouse_click", {
  title: "Mouse Click",
  description: "Click at a position on the VM screen. Coordinates are in the screenshot's coordinate space.",
  inputSchema: {
    x: z.number().int().nonnegative().describe("X coordinate in screenshot space"),
    y: z.number().int().nonnegative().describe("Y coordinate in screenshot space"),
    button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ x, y, button, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const scaleFactor = lastScaleFactors.get(id) ?? calculateScaleFactor(fb.width, fb.height);
  const coords = scaleCoordinates(x, y, scaleFactor, fb.width, fb.height);

  session.click(coords.x, coords.y, button);

  return {
    content: [{
      type: "text" as const,
      text: `Clicked ${button} at (${coords.x}, ${coords.y}) [screen coords from (${x}, ${y}) screenshot coords]`,
    }],
  };
});

// --- Tool: mouse_move ---

server.registerTool("mouse_move", {
  title: "Mouse Move",
  description: "Move the mouse cursor to a position on the VM screen without clicking.",
  inputSchema: {
    x: z.number().int().nonnegative().describe("X coordinate in screenshot space"),
    y: z.number().int().nonnegative().describe("Y coordinate in screenshot space"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ x, y, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const scaleFactor = lastScaleFactors.get(id) ?? calculateScaleFactor(fb.width, fb.height);
  const coords = scaleCoordinates(x, y, scaleFactor, fb.width, fb.height);

  session.sendPointerEvent(0, coords.x, coords.y);

  return {
    content: [{
      type: "text" as const,
      text: `Moved mouse to (${coords.x}, ${coords.y})`,
    }],
  };
});

// --- Tool: type_text ---

server.registerTool("type_text", {
  title: "Type Text",
  description: "Type text on the VM's keyboard. Each character is sent as a key press+release.",
  inputSchema: {
    text: z.string().min(1).describe("Text to type"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ text, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);

  session.typeText(text);

  return {
    content: [{
      type: "text" as const,
      text: `Typed ${text.length} character(s)`,
    }],
  };
});

// --- Tool: press_key ---

server.registerTool("press_key", {
  title: "Press Key",
  description: 'Press a key or key combination. Examples: "Return", "ctrl+c", "alt+tab", "shift+a", "F5", "Escape"',
  inputSchema: {
    key: z.string().min(1).describe('Key or combo (e.g. "Return", "ctrl+c", "alt+tab")'),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ key, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);

  session.pressKey(key);

  return {
    content: [{
      type: "text" as const,
      text: `Pressed key: ${key}`,
    }],
  };
});

// --- Tool: drag ---

server.registerTool("drag", {
  title: "Drag",
  description: "Drag from one position to another on the VM screen with animated easing.",
  inputSchema: {
    from_x: z.number().int().nonnegative().describe("Start X in screenshot space"),
    from_y: z.number().int().nonnegative().describe("Start Y in screenshot space"),
    to_x: z.number().int().nonnegative().describe("End X in screenshot space"),
    to_y: z.number().int().nonnegative().describe("End Y in screenshot space"),
    steps: z.number().int().positive().default(20).describe("Intermediate pointer steps (default 20)"),
    duration_ms: z.number().int().positive().default(500).describe("Total drag duration in ms (default 500)"),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).default("ease-in-out").describe("Easing curve (default ease-in-out)"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ from_x, from_y, to_x, to_y, steps, duration_ms, easing, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const scaleFactor = lastScaleFactors.get(id) ?? calculateScaleFactor(fb.width, fb.height);
  const from = scaleCoordinates(from_x, from_y, scaleFactor, fb.width, fb.height);
  const to = scaleCoordinates(to_x, to_y, scaleFactor, fb.width, fb.height);

  await session.drag(from.x, from.y, to.x, to.y, steps, duration_ms, easing);

  return {
    content: [{
      type: "text" as const,
      text: `Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y}) [${steps} steps, ${duration_ms}ms, ${easing}]`,
    }],
  };
});

// --- Tool: scroll ---

server.registerTool("scroll", {
  title: "Scroll",
  description: "Scroll the mouse wheel at a position on the VM screen.",
  inputSchema: {
    x: z.number().int().nonnegative().describe("X coordinate in screenshot space"),
    y: z.number().int().nonnegative().describe("Y coordinate in screenshot space"),
    direction: z.enum(["up", "down"]).describe("Scroll direction"),
    amount: z.number().int().positive().default(3).describe("Number of scroll clicks"),
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ x, y, direction, amount, vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  const scaleFactor = lastScaleFactors.get(id) ?? calculateScaleFactor(fb.width, fb.height);
  const coords = scaleCoordinates(x, y, scaleFactor, fb.width, fb.height);

  session.scroll(coords.x, coords.y, direction, amount);

  return {
    content: [{
      type: "text" as const,
      text: `Scrolled ${direction} ${amount} clicks at (${coords.x}, ${coords.y})`,
    }],
  };
});

// --- Tool: get_screen_size ---

server.registerTool("get_screen_size", {
  title: "Get Screen Size",
  description: "Get the current screen dimensions of the VM.",
  inputSchema: {
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ vmid }) => {
  const id = resolveVmid(vmid);
  const session = sessions.getConnectedSession(id);
  const fb = session.screen;
  if (!fb) throw new Error("Framebuffer not ready");

  return {
    content: [{
      type: "text" as const,
      text: `Screen size: ${fb.width}x${fb.height}`,
    }],
  };
});

// --- Tool: disconnect ---

server.registerTool("disconnect", {
  title: "Disconnect from VM",
  description: "Disconnect the VNC session for a VM.",
  inputSchema: {
    vmid: z.number().int().positive().optional().describe("VM ID. Uses active session if omitted."),
  },
}, async ({ vmid }) => {
  const id = resolveVmid(vmid);
  sessions.disconnect(id);
  lastScaleFactors.delete(id);
  if (activeVmid === id) activeVmid = null;

  return {
    content: [{
      type: "text" as const,
      text: `Disconnected from VM ${id}`,
    }],
  };
});

// --- Tool: list_vms ---

server.registerTool("list_vms", {
  title: "List VMs",
  description: "List all QEMU virtual machines visible to the authenticated user. Shows vmid, name, status, and node.",
  inputSchema: {},
}, async () => {
  const vms = await api.listVms();

  if (vms.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: "No VMs found (or no permissions to view any).",
      }],
    };
  }

  const lines = vms.map((vm) =>
    `VM ${vm.vmid}: name=${vm.name ?? "unknown"}, status=${vm.status}, node=${vm.node}`
  );

  return {
    content: [{
      type: "text" as const,
      text: lines.join("\n"),
    }],
  };
});

// --- Optional tools: VM power management ---

server.registerTool("vm_start", {
  title: "Start VM",
  description: "Start a stopped VM. Requires VM.PowerMgmt privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.startVm(resolvedNode, vmid);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} start requested`,
    }],
  };
});

server.registerTool("vm_shutdown", {
  title: "Shutdown VM",
  description: "Gracefully shutdown a VM via ACPI power-off. Requires VM.PowerMgmt privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.shutdownVm(resolvedNode, vmid);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} graceful shutdown requested`,
    }],
  };
});

server.registerTool("vm_stop", {
  title: "Stop VM",
  description: "Force stop a VM (like pulling the power cord). Requires VM.PowerMgmt privilege. Prefer vm_shutdown for graceful shutdown.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.stopVm(resolvedNode, vmid);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} force stop requested`,
    }],
  };
});

server.registerTool("vm_status", {
  title: "VM Status",
  description: "Get the current status of a VM (running, stopped, etc). Requires VM.Audit privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  const status = await api.getVmStatus(resolvedNode, vmid);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid}: status=${status.status}, qmpstatus=${status.qmpstatus ?? "n/a"}, name=${status.name ?? "unknown"}`,
    }],
  };
});

server.registerTool("exec_command", {
  title: "Execute Command in VM",
  description: "Execute a command inside the VM via QEMU guest agent. Requires qemu-guest-agent running in the VM and VM.GuestAgent.Unrestricted privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    command: z.string().min(1).describe("Command to execute"),
    args: z.array(z.string()).optional().describe("Command arguments"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, command, args, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  const result = await api.guestExec(resolvedNode, vmid, command, args);

  return {
    content: [{
      type: "text" as const,
      text: `Exit code: ${result.exitcode}\nStdout: ${result.stdout}\nStderr: ${result.stderr}`,
    }],
  };
});

// --- Snapshot tools ---

server.registerTool("snapshot_list", {
  title: "List Snapshots",
  description: "List all snapshots for a VM. Requires VM.Audit privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  const snapshots = await api.listSnapshots(resolvedNode, vmid);

  // Filter out the "current" pseudo-snapshot
  const real = snapshots.filter((s) => s.name !== "current");

  if (real.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `VM ${vmid} has no snapshots.`,
      }],
    };
  }

  const lines = real.map((s) => {
    const time = s.snaptime ? new Date(s.snaptime * 1000).toISOString() : "n/a";
    const desc = s.description ?? "";
    const mem = s.vmstate ? " [+memory]" : "";
    return `  ${s.name} — ${time}${mem}${desc ? ` — ${desc}` : ""}`;
  });

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} snapshots:\n${lines.join("\n")}`,
    }],
  };
});

server.registerTool("snapshot_create", {
  title: "Create Snapshot",
  description: "Create a snapshot of a VM. Requires VM.Snapshot privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    name: z.string().min(1).describe("Snapshot name"),
    description: z.string().optional().describe("Snapshot description"),
    vmstate: z.boolean().default(false).describe("Include VM memory state (default false)"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, name, description, vmstate, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.createSnapshot(resolvedNode, vmid, name, description, vmstate);

  return {
    content: [{
      type: "text" as const,
      text: `Snapshot "${name}" created for VM ${vmid}${vmstate ? " (with memory state)" : ""}`,
    }],
  };
});

server.registerTool("snapshot_delete", {
  title: "Delete Snapshot",
  description: "Delete a snapshot from a VM. Requires VM.Snapshot privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    name: z.string().min(1).describe("Snapshot name to delete"),
    force: z.boolean().default(false).describe("Force removal of stuck snapshots (default false)"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, name, force, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.deleteSnapshot(resolvedNode, vmid, name, force);

  return {
    content: [{
      type: "text" as const,
      text: `Snapshot "${name}" deletion requested for VM ${vmid}`,
    }],
  };
});

server.registerTool("snapshot_rollback", {
  title: "Rollback Snapshot",
  description: "Rollback a VM to a previous snapshot. The VM will be stopped and restored. Requires VM.Snapshot privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    name: z.string().min(1).describe("Snapshot name to rollback to"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, name, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.rollbackSnapshot(resolvedNode, vmid, name);

  return {
    content: [{
      type: "text" as const,
      text: `VM ${vmid} rollback to snapshot "${name}" requested`,
    }],
  };
});

// --- Backup tools ---

server.registerTool("backup_create", {
  title: "Create Backup",
  description: "Create a backup (vzdump) of a VM. Requires VM.Backup privilege.",
  inputSchema: {
    vmid: z.number().int().positive().describe("VM ID"),
    storage: z.string().optional().describe("Target storage (must support backups)"),
    compress: z.enum(["0", "gzip", "lzo", "zstd"]).default("zstd").describe("Compression algorithm (default zstd)"),
    mode: z.enum(["snapshot", "stop", "suspend"]).default("snapshot").describe("Backup mode: snapshot (live), stop (consistent), suspend (compat)"),
    notes: z.string().optional().describe("Backup notes template"),
    node: z.string().optional().describe("PVE node name. Auto-detected if omitted."),
  },
}, async ({ vmid, storage, compress, mode, notes, node }) => {
  const resolvedNode = node ?? await api.findVmNode(vmid);
  await api.createBackup(resolvedNode, vmid, storage, compress, mode, notes);

  return {
    content: [{
      type: "text" as const,
      text: `Backup of VM ${vmid} started (mode=${mode}, compress=${compress}${storage ? `, storage=${storage}` : ""})`,
    }],
  };
});

server.registerTool("backup_list", {
  title: "List Backups",
  description: "List backup files from a storage. Requires access to the storage.",
  inputSchema: {
    storage: z.string().describe("Storage name to list backups from"),
    vmid: z.number().int().positive().optional().describe("Filter by VM ID"),
    node: z.string().describe("PVE node name"),
  },
}, async ({ storage, vmid, node }) => {
  const backups = await api.listBackups(node, storage, vmid);

  if (backups.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `No backups found in storage "${storage}"${vmid ? ` for VM ${vmid}` : ""}.`,
      }],
    };
  }

  const lines = backups.map((b) => {
    const time = new Date(b.ctime * 1000).toISOString();
    const sizeMb = (b.size / 1024 / 1024).toFixed(1);
    const prot = b.protected ? " [protected]" : "";
    return `  ${b.volid} — ${time} — ${sizeMb} MB${prot}${b.notes ? ` — ${b.notes}` : ""}`;
  });

  return {
    content: [{
      type: "text" as const,
      text: `Backups in "${storage}"${vmid ? ` for VM ${vmid}` : ""}:\n${lines.join("\n")}`,
    }],
  };
});

// --- Main ---

async function main(): Promise<void> {
  const credentials = loadCredentialsFromEnv();
  auth = new PveAuthManager(credentials);
  api = new PveApiClient(auth);
  sessions = new VncSessionManager(api);

  // Authenticate immediately to fail fast on bad credentials
  await auth.authenticate();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  sessions?.disconnectAll();
  auth?.destroy();
  destroyDispatchers();
  process.exit(0);
}
