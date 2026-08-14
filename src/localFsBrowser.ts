/** Minimal directory-entry descriptor returned by local fs bridge when `withFileTypes` is `true`. */
type DirentLike = {
	name: string;
	dir: boolean;
}

/** Minimal file-stat descriptor returned by local fs bridge. */
type StatsLike = {
	dir: boolean;
}

const buildUrl = (targetPath: string, params: Record<string, string> = {}) => {
	const normalizedPath = targetPath.replace(/^\.?\//, '')
	const url = new URL(`/__fs/${normalizedPath}`, window.location.origin)
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}
	return url.toString()
}

const assertOk = async (response: Response) => {
	if (!response.ok) {
		throw new Error(await response.text())
	}
	return response
}

async function readdir(targetPath: string, withFileTypes: true): Promise<DirentLike[]>
async function readdir(targetPath: string, withFileTypes?: false): Promise<string[]>
async function readdir(targetPath: string, withFileTypes?: true | false): Promise<DirentLike[] | string[]> {
	const response = await assertOk(await fetch(buildUrl(targetPath, {
		cmd: 'readdir',
		...(withFileTypes ? { withFileTypes: 'true' } : {})
	})))
	return response.json()
}

const fs = {
	readdir,
	readFile: async (targetPath: string): Promise<string> => {
		const response = await assertOk(await fetch(buildUrl(targetPath, { cmd: 'readFile' })))
		return response.text()
	},
	stat: async (targetPath: string): Promise<StatsLike> => {
		const response = await assertOk(await fetch(buildUrl(targetPath, { cmd: 'stat' })))
		return response.json()
	},
	writeFile: async (targetPath: string, data: string | ArrayBufferView | DataView): Promise<void> => {
		await assertOk(await fetch(buildUrl(targetPath, { cmd: 'writeFile' }), {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			body: typeof data === 'string' ? data : new TextDecoder().decode(data)
		}))
	},
	rm: async (targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> => {
		await assertOk(await fetch(buildUrl(targetPath, {
			cmd: 'rm',
			...(options?.recursive ? { recursive: 'true' } : {}),
			...(options?.force ? { force: 'true' } : {})
		}), {
			method: 'DELETE'
		}))
	}
}

export default fs
