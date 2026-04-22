import { readFile } from 'node:fs/promises'

export interface GuidanceTopic {
	readonly id: string
	readonly title: string
	readonly description: string
	readonly filename: string
}

export const GUIDANCE_TOPICS = [
	{
		id: 'secure_boot',
		title: 'Disable Secure Boot on OVMF VMs',
		description:
			'Recreate efidisk0 without pre-enrolled-keys to disable Secure Boot cleanly on cloned or template-derived OVMF VMs.',
		filename: 'secure-boot.md',
	},
] as const satisfies readonly GuidanceTopic[]

export type GuidanceTopicId = (typeof GUIDANCE_TOPICS)[number]['id']

export const guidanceTopicIds = GUIDANCE_TOPICS.map((t) => t.id) as [
	GuidanceTopicId,
	...GuidanceTopicId[],
]

export function guidanceTopicUri(id: GuidanceTopicId): string {
	return `guide://${id.replace(/_/g, '-')}`
}

export function findGuidanceTopic(id: GuidanceTopicId): (typeof GUIDANCE_TOPICS)[number] {
	const topic = GUIDANCE_TOPICS.find((t) => t.id === id)
	if (!topic) throw new Error(`Unknown guidance topic: ${id}`)
	return topic
}

export async function readGuidance(id: GuidanceTopicId): Promise<string> {
	const topic = findGuidanceTopic(id)
	const url = new URL(`../docs/guides/${topic.filename}`, import.meta.url)
	const text = await readFile(url, 'utf8')
	return text.trim()
}
