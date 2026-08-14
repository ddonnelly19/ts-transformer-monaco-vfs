import * as tsvfs from "@typescript/vfs"
import ts from 'typescript'
import { transpileCode } from "./utils"

export async function runTransform({
	inputFileName,
	source,
	transformCode,
	compilerOptions = {},
}: {
	inputFileName: string,
	source: string
	transformCode: string
	compilerOptions?: Partial<ts.CompilerOptions>
}) {
	const errors: { message: string; error: any }[] = []
	const errorPositions: { line: number; column: number; message: string }[] = []

	const options: ts.CompilerOptions = {
		...compilerOptions,
		target: ts.ScriptTarget.ES2024,
		module: ts.ModuleKind.ESNext,
		declaration: true,
		emitDeclarationOnly: false,
		newLine: ts.NewLineKind.LineFeed,
		outDir: "dist"
	}

	// Prepare VFS with libs from CDN
	const fsMap = await tsvfs.createDefaultMapFromCDN(options, ts.version, true, ts);
	//const inputFileName = 'input.js'
	fsMap.set(inputFileName, source)
	var system = tsvfs.createSystem(fsMap);
	//var env = tsvfs.createVirtualTypeScriptEnvironment(tsvfs.createSystem(fsMap), [inputFileName], ts, options)

	// 1) Compile transformCode (TypeScript) to CommonJS JavaScript
	let compiledTransformJS = transpileCode(transformCode)

	let transformerFactory: (
		ts: typeof import("typescript"),
		system: import("typescript").System,
		compilerHost: import("typescript").CompilerHost,
		languageServiceHost: import("typescript").LanguageServiceHost,
		options: import("typescript").CompilerOptions,
		inputFileName: string
	) => void = (await import("./transformer")).default


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

	
	const vCh = tsvfs.createVirtualCompilerHost(system, options, ts);
	const vLsh = tsvfs.createVirtualLanguageServiceHost(system, [inputFileName], options, ts);


	// Create Program on VFS (unchanged)

	//const tr = ts.transform(sf, [transformerFactory])
	transformerFactory(
		ts, 
		system, 
		vCh.compilerHost, 
		vLsh.languageServiceHost, 
		options, 
		inputFileName
	);

	var env = tsvfs.createVirtualTypeScriptEnvironment(system, [inputFileName], ts, options);
	var sf = env.getSourceFile(inputFileName);
	var transformedTsText = env.sys.readFile(inputFileName)!
	//const transformedSf = tr.transformed[0] as ts.SourceFile

	var program = ts.createProgram({
		rootNames: [inputFileName],
		options,
		host: vCh.compilerHost
	});

	/*const pre = ts.getPreEmitDiagnostics(program)
	for (const d of pre) {
		const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
		if (d.file && typeof d.start === 'number') {
			const { line, character } = ts.getLineAndCharacterOfPosition(d.file, d.start)
			errors.push({
				message: `${d.file.fileName} (${line + 1},${character + 1})`,
				error:  msg})
			errorPositions.push({ line: line + 1, column: character + 1, message: msg })
		} else {
			errors.push({
				message: "Diagnostics",
				error: msg
			})
		}
	}*/

	const emitResult = program.emit(sf, undefined, undefined, false, {
		before: [
			//(context) => (sf) => sf
		],
		after: undefined
	});
	for (const d of emitResult.diagnostics) {
		const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
		if (d.file && typeof d.start === 'number') {
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

	const emittedJs = env.sys.readFile('dist/input.js') || ''
	const dts = env.sys.readFile('dist/input.d.ts') || ''
	env.languageService.dispose();
	return { transformedTs: transformedTsText, emittedJs, dts, errors, errorPositions }
}
