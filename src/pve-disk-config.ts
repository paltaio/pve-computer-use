export interface ParsedDriveSpec {
	storage: string
	volume: string
	options: Map<string, string>
}

export interface VmDiskEntry {
	key: string
	interface: string
	index?: number
	spec: string
	parsed?: ParsedDriveSpec
}

function parseDriveSegment(spec: string): { storage: string; volume: string } {
	const firstComma = spec.indexOf(',')
	const driveSegment = firstComma === -1 ? spec : spec.slice(0, firstComma)
	const separatorIndex = driveSegment.indexOf(':')

	if (separatorIndex <= 0 || separatorIndex === driveSegment.length - 1) {
		throw new Error(`Malformed drive spec: expected storage:volume, got "${spec}"`)
	}

	return {
		storage: driveSegment.slice(0, separatorIndex).trim(),
		volume: driveSegment.slice(separatorIndex + 1).trim(),
	}
}

export function parseDriveSpec(spec: string): ParsedDriveSpec {
	const trimmed = spec.trim()
	if (!trimmed) {
		throw new Error('Malformed drive spec: empty value')
	}

	const { storage, volume } = parseDriveSegment(trimmed)
	const options = new Map<string, string>()
	const firstComma = trimmed.indexOf(',')

	if (firstComma !== -1) {
		const rawOptions = trimmed
			.slice(firstComma + 1)
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean)

		for (const option of rawOptions) {
			const equalsIndex = option.indexOf('=')
			if (equalsIndex <= 0 || equalsIndex === option.length - 1) {
				throw new Error(`Malformed drive spec option "${option}" in "${spec}"`)
			}

			options.set(option.slice(0, equalsIndex).trim(), option.slice(equalsIndex + 1).trim())
		}
	}

	return { storage, volume, options }
}

const VM_DISK_KEY_PATTERN = /^(ide|sata|scsi|virtio|efidisk|tpmstate|unused)(\d+)$/

export function isVmDiskKey(key: string): boolean {
	return VM_DISK_KEY_PATTERN.test(key)
}

export function listVmDiskEntries(config: Record<string, unknown>): VmDiskEntry[] {
	return Object.entries(config)
		.filter(
			(entry): entry is [string, string] => isVmDiskKey(entry[0]) && typeof entry[1] === 'string',
		)
		.map(([key, value]) => {
			const match = VM_DISK_KEY_PATTERN.exec(key)
			const diskInterface = match?.[1] ?? key
			const rawIndex = match?.[2]
			let parsed: ParsedDriveSpec | undefined

			try {
				parsed = parseDriveSpec(value)
			} catch {
				parsed = undefined
			}

			return {
				key,
				interface: diskInterface,
				index: rawIndex !== undefined ? Number.parseInt(rawIndex, 10) : undefined,
				spec: value,
				parsed,
			}
		})
}
