import type { VmStatus } from './pve-api.js'

export function formatVmTags(tags: string[]): string {
	return tags.length > 0 ? tags.join(',') : '-'
}

export function matchesVmFilters(
	vm: VmStatus,
	filters: {
		vmids?: number[]
		tags?: string[]
		statuses?: string[]
		name?: string
	},
): boolean {
	if (filters.vmids && !filters.vmids.includes(vm.vmid)) return false
	if (filters.tags && !filters.tags.some((tag) => vm.tags.includes(tag))) return false
	if (filters.statuses && !filters.statuses.includes(vm.status)) return false
	if (filters.name) {
		const vmName = (vm.name ?? '').toLowerCase()
		if (!vmName.includes(filters.name)) return false
	}
	return true
}

export function mouseButtonToBit(button: 'left' | 'right' | 'middle'): number {
	return button === 'left' ? 1 : button === 'middle' ? 2 : 4
}

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))
