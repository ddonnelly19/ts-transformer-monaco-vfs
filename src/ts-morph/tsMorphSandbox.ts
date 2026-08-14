import { createDefaultMapFromCDN } from "@typescript/vfs";
import { Project, ts } from "ts-morph";
//import * as tsmorph from "ts-morph";
import { isDiagnosticWithLocation } from "../ts/utils";

/**
 * Runs a user-authored TypeScript transformer against the given source using
 * ts-morph's high-level Project API and an in-memory file system.
 *
 * Steps performed:
 * 1. Builds a VFS pre-populated with TypeScript standard library files (from CDN).
 * 2. Creates a ts-morph `Project` and populates it with the VFS contents.
 * 3. Imports and executes the transformer from `./tsmorphTransformer`.
 * 4. Emits to memory and extracts the JavaScript output and `.d.ts` declaration.
 *
 * @param source - TypeScript/JavaScript source code to transform.
 * @param transformCode - Source of the transformer script (unused directly here —
 *   the runtime entry point `./tsmorphTransformer` is imported dynamically).
 * @param compilerOptions - Compiler options forwarded to the ts-morph `Project`.
 * @returns An object with `transformedTs`, `emittedJs`, `dts`, `errors`, and
 *   `errorPositions`.
 */
export async function runTransform({

	source,
	transformCode,
	compilerOptions = {},
}: {
	source: string
	transformCode: string
	compilerOptions?: Partial<ts.CompilerOptions>
}) {
	const errors: { message: string; error: any }[] = []
	const errorPositions: { line: number; column: number; message: string }[] = []

	const options = {
		...compilerOptions,
		target: ts.ScriptTarget.ES2024,
		module: ts.ModuleKind.ESNext,
		declaration: true,
		emitDeclarationOnly: false,
		newLine: ts.NewLineKind.LineFeed,
		outDir: "dist",
		"allowJs": true,
		"checkJs": true,
		"allowNonTsExtensions": true,
		"allowSyntheticDefaultImports": true,
		"paths": {
			"typescript": [
				"file:///typescript.d.ts"
			]
		}
	}

	const fsMap = await createDefaultMapFromCDN(options, ts.version, true, ts);
	const inputFileName = 'input.js'
	fsMap.set(inputFileName, source)

	var project = new Project({
		"compilerOptions": options as any,
		useInMemoryFileSystem: true
	})

	fsMap.forEach((contents, fileName) => project.createSourceFile(fileName, contents));
	//let compiledTransformJS = transpileCode(transformCode)


	let transformerFactory = (await import("./tsmorphTransformer")).default


	/*try {
		const moduleObj = { exports: {} as any }
		const fn = new Function('ts', 'module', 'exports', compiledTransformJS)
		fn(ts, moduleObj, moduleObj.exports)

		// support both `export default` and `module.exports =`
		transformerFactory = moduleObj.exports?.default ?? moduleObj.exports

		if (typeof transformerFactory !== 'function') {
			throw new Error('Transform script must export a function (context) => (sourceFile) => ...')
		}
	} catch (e: any) {
		console.error(e);
		errors.push({
			message: 'Failed to evaluate compiled transform script:',
			error: e
		})
		return { transformedTs: '', emittedJs: '', dts: '', errors, errorPositions }
	}*/


	// Create Program on VFS (unchanged)

	//const tr = ts.transform(sf, [transformerFactory])
	transformerFactory(project);
	var transformedTsText = project.getSourceFile(inputFileName)?.print() || "";
	const emitResult = project.emitToMemory({})

	for (const d of emitResult.getDiagnostics().map(d => d.compilerObject)) {
		const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
		if (isDiagnosticWithLocation(d)) {
			const { line, character } = ts.getLineAndCharacterOfPosition(d.file, d.start)
			errors.push({
				message: `${d.file.fileName} (${line + 1},${character + 1})`,
				error: msg
			})
			errorPositions.push({ line: line + 1, column: character + 1, message: msg })
		} else {
			errors.push({
				message: "Diagnostics",
				error: msg
			})
		}
	}
	var files = emitResult.getFiles();
	const emittedJs = emitResult.getFiles().find(f => f.filePath == '/dist/input.js')?.text || ''
	const dts = emitResult.getFiles().find(f => f.filePath == '/dist/input.d.ts')?.text || ''
	return { transformedTs: transformedTsText, emittedJs, dts, errors, errorPositions }
}