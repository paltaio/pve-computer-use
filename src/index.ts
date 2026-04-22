#!/usr/bin/env node

/**
 * PVE Computer Use MCP Server
 *
 * MCP server that lets AI agents see and control Proxmox VE virtual machine
 * displays via VNC. Screenshot, click, type, scroll — computer use for VMs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { PveAuthManager, loadCredentialsFromEnv } from './pve-auth.js'
import { PveApiClient } from './pve-api.js'
import { VncSessionManager } from './vnc-session.js'
import { TerminalSessionManager } from './terminal-session.js'
import { destroyDispatchers } from './http.js'
import * as state from './state.js'

import { registerVncTools } from './tools/vnc.js'
import { registerVmTools } from './tools/vm.js'
import { registerTimelineTool } from './tools/timeline.js'
import { registerSnapshotTools } from './tools/snapshots.js'
import { registerSerialTools } from './tools/serial.js'

const server = new McpServer({
	name: 'pve-computer-use',
	version: '0.1.0',
})

registerVncTools(server)
registerVmTools(server)
registerTimelineTool(server)
registerSnapshotTools(server)
registerSerialTools(server)

async function main(): Promise<void> {
	const credentials = loadCredentialsFromEnv()
	const auth = new PveAuthManager(credentials)
	const api = new PveApiClient(auth)
	const sessions = new VncSessionManager(api)
	const termSessions = new TerminalSessionManager(api)
	state.initServices({ auth, api, sessions, termSessions })

	// Authenticate immediately to fail fast on bad credentials
	await auth.authenticate()

	const transport = new StdioServerTransport()
	await server.connect(transport)
}

main().catch((err) => {
	console.error('Fatal:', err)
	process.exit(1)
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function shutdown(): void {
	// Services may be undefined if main() threw before initServices ran
	state.sessions?.disconnectAll()
	state.termSessions?.disconnectAll()
	state.auth?.destroy()
	destroyDispatchers()
	process.exit(0)
}
