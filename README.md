# pve-computer-use

MCP server for Proxmox VE VMs. Screenshot and input over VNC, text I/O over serial console, plus power, snapshots, backups, and guest-agent exec.

## Requirements

- Node 18+
- Proxmox VE 8+
- PVE user with at least `VM.Console` + `VM.Audit`

## Install

```bash
git clone <repo-url> && cd pve-computer-use
npm install
npm run build
```

## Configure

| Variable         | Required | Default | Notes                   |
| ---------------- | -------- | ------- | ----------------------- |
| `PVE_HOST`       | yes      | --      | PVE node/cluster        |
| `PVE_PORT`       | no       | `8006`  |                         |
| `PVE_USER`       | yes      | --      | e.g. `mcp-agent@pve`    |
| `PVE_PASSWORD`   | yes      | --      |                         |
| `PVE_VERIFY_SSL` | no       | `true`  | `false` for self-signed |

MCP client config (`~/.claude/mcp_servers.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pve-computer-use": {
      "command": "node",
      "args": ["/path/to/pve-computer-use/dist/index.js"],
      "env": {
        "PVE_HOST": "192.168.1.10",
        "PVE_USER": "mcp-agent@pve",
        "PVE_PASSWORD": "your-password",
        "PVE_VERIFY_SSL": "false"
      }
    }
  }
}
```

## Tools

**Display (VNC):** `connect`, `disconnect`, `screenshot`, `get_screen_size`, `mouse_click`, `mouse_move`, `drag`, `scroll`, `type_text`, `press_key`

**Serial console:** `serial_connect`, `serial_disconnect`, `serial_read`, `serial_send`, `serial_key`, `serial_resize`

**VM management:** `list_vms`, `vm_start`, `vm_shutdown`, `vm_stop`, `vm_status`, `vm_notes`, `vm_disk_list`, `vm_disk_set`, `vm_config_delete`, `exec_command`, `timeline`

**Snapshots:** `snapshot_list`, `snapshot_create`, `snapshot_delete`, `snapshot_rollback`

**Backups:** `backup_list`, `backup_create`

`timeline` runs a scheduled sequence of actions in one call (connect, mouse/keyboard events, `exec_command`, waits). See the tool schema for the step shape.

## PVE Setup

```bash
# User
pveum user add mcp-agent@pve --password <password>

# Role (full: screen + power + snapshots + backups + guest agent)
pveum role add MCPComputerUseFull \
  --privs "VM.Console,VM.Audit,VM.PowerMgmt,VM.GuestAgent.Unrestricted,VM.Snapshot,VM.Backup,Datastore.Audit,Datastore.AllocateSpace"

# ACLs (per VM or pool, plus storage for backups)
pveum acl modify /vms/100   --users mcp-agent@pve --roles MCPComputerUseFull
pveum acl modify /storage   --users mcp-agent@pve --roles MCPComputerUseFull
```

| Privilege                                     | For                                     |
| --------------------------------------------- | --------------------------------------- |
| `VM.Console`                                  | VNC + serial                            |
| `VM.Audit`                                    | status, list, snapshot list             |
| `VM.PowerMgmt`                                | start / stop / shutdown                 |
| `VM.Snapshot`                                 | snapshot ops                            |
| `VM.Backup`                                   | backup ops (per VM)                     |
| `VM.GuestAgent.Unrestricted`                  | `exec_command` (needs qemu-guest-agent) |
| `Datastore.Audit` / `Datastore.AllocateSpace` | backup list / create (on `/storage/*`)  |

### Serial console

PVE: `qm set <vmid> -serial0 socket`

Debian/Ubuntu guest: `systemctl enable --now serial-getty@ttyS0.service`. For boot messages, add `console=ttyS0,115200n8` to `GRUB_CMDLINE_LINUX` and `update-grub`.

## Security

VNC tickets are VM-scoped and expire in ~40s. Auth tickets refresh before their 2h expiry; 403s trigger a retry with a fresh ticket. Credentials come from env vars only. Runs as a local stdio subprocess — no network exposure of the MCP server itself.

## Troubleshooting

| Symptom                             | Fix                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `401 authentication failed`         | Test creds: `curl -k -d 'username=USER&password=PW' https://HOST:8006/api2/json/access/ticket` |
| `Invalid PVEVNC Ticket`             | Ticket expires in ~40s; retry                                                                  |
| `VM not found in cluster`           | Wrong VMID or missing `VM.Audit`                                                               |
| `WebSocket closed before handshake` | VM not running, or port 8006 blocked                                                           |
| TLS errors                          | `PVE_VERIFY_SSL=false`                                                                         |
| Serial shows nothing                | No `serial0` on VM, or no getty in guest                                                       |

## License

Apache-2.0. See [LICENSE](LICENSE).
