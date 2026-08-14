import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'
import { cacheDir } from 'vite-plugin-monaco-editor/dist/workerMiddleware'
import nodefs from 'fs'
import path from 'path'

// plugin may be a CJS export wrapped object; normalize to a callable function
const monacoPlugin: typeof monacoEditorPlugin = (monacoEditorPlugin as any)?.default ?? monacoEditorPlugin

const workspaceRoot = process.cwd()

const resolveWorkspacePath = (requestPath: string) => {
	const normalized = requestPath.replace(/^\/+/, '')
	const resolved = path.resolve(workspaceRoot, normalized)
	const relative = path.relative(workspaceRoot, resolved)
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('Access outside workspace root is not allowed')
	}
	return resolved
}

const fsBridgePlugin = () => ({
	name: 'local-fs-bridge',
	configureServer(server: import('vite').ViteDevServer) {
		server.middlewares.use('/__fs', (req, res, next) => {
			void (async () => {
				try {
					const url = new URL(req.url ?? '/', 'http://localhost')
					const cmd = url.searchParams.get('cmd')
					const targetPath = resolveWorkspacePath(decodeURIComponent(url.pathname.replace(/^\//, '')))

					if (!cmd) {
						res.statusCode = 400
						res.end('Command query param not specified')
						return
					}

					if (cmd === 'readFile') {
						const data = await nodefs.promises.readFile(targetPath, 'utf8')
						res.setHeader('Content-Type', 'text/plain; charset=utf-8')
						res.end(data)
						return
					}

					if (cmd === 'writeFile') {
						const chunks: Buffer[] = []
						for await (const chunk of req) {
							chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
						}
						await nodefs.promises.mkdir(path.dirname(targetPath), { recursive: true })
						await nodefs.promises.writeFile(targetPath, Buffer.concat(chunks).toString('utf8'))
						res.statusCode = 200
						res.end('OK')
						return
					}

					if (cmd === 'readdir') {
						const withFileTypes = url.searchParams.get('withFileTypes') === 'true'
						if (withFileTypes) {
							const entries = await nodefs.promises.readdir(targetPath, { withFileTypes: true })
							res.setHeader('Content-Type', 'application/json; charset=utf-8')
							res.end(JSON.stringify(entries
								.filter((entry) => entry.isFile() || entry.isDirectory())
								.map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))))
							return
						}
						const entries = await nodefs.promises.readdir(targetPath)
						res.setHeader('Content-Type', 'application/json; charset=utf-8')
						res.end(JSON.stringify(entries))
						return
					}

					if (cmd === 'stat') {
						const stats = await nodefs.promises.stat(targetPath)
						res.setHeader('Content-Type', 'application/json; charset=utf-8')
						res.end(JSON.stringify({ dir: stats.isDirectory() }))
						return
					}

					if (cmd === 'rm') {
						const recursive = url.searchParams.get('recursive') === 'true'
						const force = url.searchParams.get('force') === 'true'
						await nodefs.promises.rm(targetPath, { recursive, force })
						res.statusCode = 200
						res.end('OK')
						return
					}

					res.statusCode = 400
					res.end(`Unsupported cmd: ${cmd}`)
				} catch (error) {
					res.statusCode = 500
					res.end(error instanceof Error ? error.message : String(error))
				}
			})().catch(next)
		})
	}
})

if (nodefs.existsSync(cacheDir)) {
	nodefs.rmSync(cacheDir, { recursive: true, force: true });
}

export default defineConfig(() => ({
	plugins: [
		react(),
		fsBridgePlugin(),
		monacoPlugin({
			//"forceBuildCDN": false,
			publicPath: 'monacoeditorwork', // local path under /dist in build
			globalAPI: true,
			languageWorkers: ['editorWorkerService', 'typescript', 'json'],
			customWorkers: [],
		})
	],
	build: {
		"minify": false,
		//sourcemap: "inline",
		//"emptyOutDir": true,
		rollupOptions: {
			external: ['path', 'perf_hooks']
		}
	},
	server: {
		port: 5173,
		strictPort: true
	}
}))
