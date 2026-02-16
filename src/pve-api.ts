/**
 * PVE API Client
 *
 * Thin HTTP client for the Proxmox VE REST API.
 * All calls go through the auth manager for ticket + CSRF token.
 */

import { httpRequest } from "./http.js";
import type { PveAuthManager } from "./pve-auth.js";

export interface VncProxyResult {
  port: string;
  ticket: string;
  password: string;
}

export interface TermProxyResult {
  port: string;
  ticket: string;
  user: string;
}

export interface VmStatus {
  vmid: number;
  name: string;
  status: string;
  node: string;
  type: string;
}

export interface Snapshot {
  name: string;
  description?: string;
  snaptime?: number;
  vmstate?: boolean;
  parent?: string;
}

export interface BackupVolume {
  volid: string;
  size: number;
  ctime: number;
  format: string;
  vmid?: number;
  notes?: string;
  protected?: boolean;
}

export interface GuestExecResult {
  exitcode: number;
  stdout: string;
  stderr: string;
  exited: boolean;
}

export class PveApiClient {
  constructor(private auth: PveAuthManager) {}

  private async request<T>(method: string, path: string, body?: Record<string, string>, extraHeaders?: Record<string, string>): Promise<T> {
    const resp = await this.doRequest(method, path, body, extraHeaders);

    // On 403, force a fresh ticket and retry once — permissions may have changed
    if (resp.status === 403) {
      await this.auth.forceRefresh();
      const retry = await this.doRequest(method, path, body, extraHeaders);
      if (!retry.ok) {
        const text = await retry.text();
        throw new Error(`PVE API ${method} ${path} failed (${retry.status}): ${text}`);
      }
      const json = (await retry.json()) as { data: T };
      return json.data;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`PVE API ${method} ${path} failed (${resp.status}): ${text}`);
    }

    const json = (await resp.json()) as { data: T };
    return json.data;
  }

  private async doRequest(method: string, path: string, body?: Record<string, string>, extraHeaders?: Record<string, string>) {
    const ticket = await this.auth.getTicket();

    const headers: Record<string, string> = {
      Cookie: `PVEAuthCookie=${ticket.ticket}`,
    };

    if (method !== "GET") {
      headers["CSRFPreventionToken"] = ticket.csrfToken;
    }

    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }

    let reqBody: string | undefined;
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      reqBody = new URLSearchParams(body).toString();
    }

    return httpRequest(`${this.auth.baseUrl}/api2/json${path}`, {
      method,
      headers,
      body: reqBody,
      verifySsl: this.auth.verifySsl,
    });
  }

  /**
   * Request a VNC proxy session for a QEMU VM.
   * Returns port, VNC ticket, and password needed for WebSocket connection.
   */
  async vncProxy(node: string, vmid: number): Promise<VncProxyResult> {
    return this.request<VncProxyResult>("POST", `/nodes/${node}/qemu/${vmid}/vncproxy`, {
      websocket: "1",
      "generate-password": "1",
    });
  }

  /**
   * Get the WebSocket URL for VNC connection.
   * The vncticket must be URL-encoded.
   */
  getVncWebSocketUrl(node: string, vmid: number, port: string, vncticket: string): string {
    const encodedTicket = encodeURIComponent(vncticket);
    return `wss://${this.auth.baseUrl.replace("https://", "")}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${port}&vncticket=${encodedTicket}`;
  }

  /**
   * Request a terminal proxy session for a QEMU VM serial console.
   * Returns port and ticket needed for WebSocket connection.
   */
  async termProxy(node: string, vmid: number, serial?: string): Promise<TermProxyResult> {
    const body: Record<string, string> | undefined = serial !== undefined ? { serial } : undefined;
    // Referer with xtermjs=1 tells PVE to use text-mode protocol instead of VNC binary
    const referer = `${this.auth.baseUrl}/?console=kvm&xtermjs=1&vmid=${vmid}&node=${node}`;
    return this.request<TermProxyResult>("POST", `/nodes/${node}/qemu/${vmid}/termproxy`, body, { Referer: referer });
  }

  /**
   * Get the WebSocket URL for terminal connection.
   * Uses the same vncwebsocket endpoint as VNC — PVE reuses it for terminal proxy.
   */
  getTermWebSocketUrl(node: string, vmid: number, port: string, vncticket: string): string {
    const encodedTicket = encodeURIComponent(vncticket);
    return `wss://${this.auth.baseUrl.replace("https://", "")}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${port}&vncticket=${encodedTicket}`;
  }

  /**
   * Get the auth cookie value for WebSocket connection headers.
   */
  async getAuthCookie(): Promise<string> {
    const ticket = await this.auth.getTicket();
    return ticket.ticket;
  }

  async getVmStatus(node: string, vmid: number): Promise<{ status: string; name?: string; qmpstatus?: string }> {
    return this.request("GET", `/nodes/${node}/qemu/${vmid}/status/current`);
  }

  async startVm(node: string, vmid: number): Promise<string> {
    return this.request("POST", `/nodes/${node}/qemu/${vmid}/status/start`);
  }

  async stopVm(node: string, vmid: number): Promise<string> {
    return this.request("POST", `/nodes/${node}/qemu/${vmid}/status/stop`);
  }

  async shutdownVm(node: string, vmid: number): Promise<string> {
    return this.request("POST", `/nodes/${node}/qemu/${vmid}/status/shutdown`);
  }

  /**
   * List all VMs across the cluster. Returns vmid, name, status, and node.
   */
  async listVms(): Promise<VmStatus[]> {
    const resources = await this.request<Array<{ vmid: number; name: string; status: string; node: string; type: string }>>(
      "GET",
      "/cluster/resources?type=vm",
    );
    return resources.filter((r) => r.type === "qemu");
  }

  /**
   * Find which node a VM is on. Useful when the caller only knows vmid.
   */
  async findVmNode(vmid: number): Promise<string> {
    const vms = await this.listVms();
    const vm = vms.find((v) => v.vmid === vmid);
    if (!vm) throw new Error(`VM ${vmid} not found in cluster`);
    return vm.node;
  }

  // --- Snapshots ---

  async listSnapshots(node: string, vmid: number): Promise<Snapshot[]> {
    return this.request("GET", `/nodes/${node}/qemu/${vmid}/snapshot`);
  }

  async createSnapshot(node: string, vmid: number, snapname: string, description?: string, vmstate?: boolean): Promise<string> {
    const body: Record<string, string> = { snapname };
    if (description) body.description = description;
    if (vmstate) body.vmstate = "1";
    return this.request("POST", `/nodes/${node}/qemu/${vmid}/snapshot`, body);
  }

  async deleteSnapshot(node: string, vmid: number, snapname: string, force?: boolean): Promise<string> {
    const query = force ? "?force=1" : "";
    return this.request("DELETE", `/nodes/${node}/qemu/${vmid}/snapshot/${encodeURIComponent(snapname)}${query}`);
  }

  async rollbackSnapshot(node: string, vmid: number, snapname: string): Promise<string> {
    return this.request("POST", `/nodes/${node}/qemu/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`);
  }

  // --- Backups ---

  async createBackup(node: string, vmid: number, storage?: string, compress?: string, mode?: string, notes?: string): Promise<string> {
    const body: Record<string, string> = { vmid: String(vmid) };
    if (storage) body.storage = storage;
    if (compress) body.compress = compress;
    if (mode) body.mode = mode;
    if (notes) body["notes-template"] = notes;
    return this.request("POST", `/nodes/${node}/vzdump`, body);
  }

  async listBackups(node: string, storage: string, vmid?: number): Promise<BackupVolume[]> {
    let query = "?content=backup";
    if (vmid !== undefined) query += `&vmid=${vmid}`;
    return this.request("GET", `/nodes/${node}/storage/${encodeURIComponent(storage)}/content${query}`);
  }

  /**
   * Execute a command inside the VM via QEMU guest agent.
   * Requires qemu-guest-agent running in the VM and VM.GuestAgent.Unrestricted privilege.
   */
  async guestExec(node: string, vmid: number, command: string, args?: string[]): Promise<GuestExecResult> {
    const execBody: Record<string, string> = { command };
    if (args && args.length > 0) {
      execBody["input-data"] = JSON.stringify(args);
    }

    const { pid } = await this.request<{ pid: number }>(
      "POST",
      `/nodes/${node}/qemu/${vmid}/agent/exec`,
      execBody,
    );

    // Poll for completion
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 1000));

      const status = await this.request<GuestExecResult>(
        "GET",
        `/nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`,
      );

      if (status.exited) {
        return status;
      }
    }

    throw new Error(`Guest exec command did not complete within ${maxAttempts} seconds`);
  }
}
