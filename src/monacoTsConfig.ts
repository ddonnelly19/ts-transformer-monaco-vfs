// vite: import the d.ts as text
// @ts-ignore
//import tsTypes from 'typescript/lib/typescript.d.ts?raw'
import tsTypes from "../typescript.internal.d.ts?raw";
import utils from "../src/ts/utils.ts?raw";

export function configureMonacoTs(monacoInstance: typeof import('monaco-editor') | null) {
	// prefer provided monaco instance (from @monaco-editor/react onMount)
	const mon = monacoInstance

	const ts = mon?.typescript

	if (!ts || !ts.typescriptDefaults) {
		//console.warn('TypeScript service not available yet')
		return false
	}

	const defaults = ts.typescriptDefaults

	defaults.setEagerModelSync(true)
	defaults.setCompilerOptions({
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		strict: true,
		noImplicitAny: true,
		noUncheckedIndexedAccess: true,
		allowJs: true,
		checkJs: true,
		allowNonTsExtensions: true,
		allowSyntheticDefaultImports: true,
		"paths": {
      		"typescript": ["file:///typescript.d.ts"],
			//"@typescript/vfs": ["file:///./node_modules/@typescript/vfs/dist/index.d.ts"]
    	}
	})
	defaults.setDiagnosticsOptions({
		noSemanticValidation: false,
		noSyntaxValidation: false,
	})	

	defaults.addExtraLib(tsTypes, 'file:///typescript.d.ts')

	// Ambient declaration: provide IntelliSense for global `ts` symbol
	const ambientTs = `import * as ts from "./typescript";`
	const fileName = 'file:///ambient/ts-global.d.ts'
	defaults.addExtraLib(ambientTs, fileName)
	defaults.addExtraLib(utils, "file:///utils.ts")
	defaults.addExtraLib(`declare const ts: typeof import("typescript")`, `file:///ambient/ts-global2.d.ts`)

	return true
}
