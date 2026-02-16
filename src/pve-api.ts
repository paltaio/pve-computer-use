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

export interface VmStatus {
  vmid: number;
  name: string;
  status: string;
  node: string;
  type: string;
}

export interface GuestExecResult {
  exitcode: number;
  stdout: string;
  stderr: string;
  exited: boolean;
}

export class PveApiClient {
  constructor(private auth: PveAuthManager) {}

  private async request<T>(method: string, path: string, body?: Record<string, string>): Promise<T> {
    const ticket = await this.auth.getTicket();

    const headers: Record<string, string> = {
      Cookie: `PVEAuthCookie=${ticket.ticket}`,
    };

    if (method !== "GET") {
      headers["CSRFPreventionToken"] = ticket.csrfToken;
    }

    let reqBody: string | undefined;
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      reqBody = new URLSearchParams(body).toString();
    }

    const resp = await httpRequest(`${this.auth.baseUrl}/api2/json${path}`, {
      method,
      headers,
      body: reqBody,
      verifySsl: this.auth.verifySsl,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`PVE API ${method} ${path} failed (${resp.status}): ${text}`);
    }

    const json = (await resp.json()) as { data: T };
    return json.data;
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
