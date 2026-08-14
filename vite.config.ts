import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'

// plugin may be a CJS export wrapped object; normalize to a callable function
const monacoPlugin: typeof monacoEditorPlugin = (monacoEditorPlugin as any)?.default ?? monacoEditorPlugin

export default defineConfig({
	plugins: [
		react(),
		monacoPlugin({
			//"forceBuildCDN": false,
			publicPath: 'monacoeditorwork', // local path under /dist in build
			globalAPI: true,
		})
	],
	build: { 
		"minify": false,
		sourcemap: "inline", 
		"emptyOutDir": true
	},
	server: { 
		port: 5173, 
		strictPort: true
	}
})
