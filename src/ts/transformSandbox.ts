import * as tsvfs from "@typescript/vfs";
import ts from "typescript";
import { sourceFileAST } from "./SymbolSerializer";

/** Signature expected of a dynamically loaded transform module. */
type TransformerFn = ({
	program,
	languageServiceHost,
}: {
	program?: ts.Program;
	languageServiceHost?: ts.LanguageServiceHost;
}) => ts.TransformerFactory<ts.SourceFile>;

interface RunTransformOutput {
	transformedTs: string;
	emittedJs: string;
	dts: string;
	structure: string;
	errors: { message: string; error: unknown }[];
	errorPositions: { line: number; column: number; message: string }[];
	debugLogs: string[];
	compilerOptions: ts.CompilerOptions;
}

interface RunTransformInput {
	inputFileName: string;
	source: string;
	transformerPath: string;
	compilerOptions?: ts.CompilerOptions;
}

function scriptKind(fileName: string): ts.ScriptKind {
	if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
	if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
	if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
	if (/\.json$/i.test(fileName)) return ts.ScriptKind.JSON;
	return ts.ScriptKind.TS;
}

function outputFileName(inputFileName: string, extension: ".js" | ".d.ts"): string {
	const baseName = inputFileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
	return `dist/${baseName}${extension}`;
}

function collectDiagnostics(
	diagnostics: readonly ts.Diagnostic[],
	errors: { message: string; error: unknown }[],
	errorPositions: { line: number; column: number; message: string }[],
): void {
	for (const diagnostic of diagnostics) {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
		if (diagnostic.file && typeof diagnostic.start === "number") {
			const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
			errors.push({
				message: `${diagnostic.file.fileName} (${line + 1},${character + 1})`,
				error: message,
			});
			errorPositions.push({ line: line + 1, column: character + 1, message });
		} else {
			errors.push({ message: "Diagnostics", error: message });
		}
	}
}

/**
 * Runs a source transformer in two compiler passes.
 *
 * Pass 1 transforms and prints the source text.
 * Pass 2 creates a completely new Program from that transformed text before
 * type checking and declaration emit. This is required when a transformer
 * introduces public declarations or changes inferred public types.
 */
export async function runTransform({
	inputFileName,
	source,
	transformerPath,
	compilerOptions = {},
}: RunTransformInput): Promise<RunTransformOutput> {
	const errors: { message: string; error: unknown }[] = [];
	const errorPositions: { line: number; column: number; message: string }[] = [];
	const debugLogs: string[] = [];

	const parsed = ts.parseJsonConfigFileContent(
		{ compilerOptions, files: [] },
		{} as ts.ParseConfigHost,
		"",
	);

	const options: ts.CompilerOptions = {
		...parsed.options,
		declaration: true,
		emitDeclarationOnly: false,
		newLine: ts.NewLineKind.LineFeed,
		outDir: "dist",
		allowJs: true,
		checkJs: true,
		allowNonTsExtensions: true,
		allowSyntheticDefaultImports: true,
		paths: {
			...parsed.options.paths,
			typescript: ["file:///typescript.d.ts"],
		},
	};

	console.info(`Transforming with ${transformerPath}`);

	const fsMap = await tsvfs.createDefaultMapFromCDN(options, ts.version, true, ts);
	fsMap.set(inputFileName, source);

	// Pass 1 uses the original program only to give the transformer semantic data.
	const pass1System = tsvfs.createSystem(fsMap);
	const pass1CompilerHost = tsvfs.createVirtualCompilerHost(pass1System, options, ts).compilerHost;
	const pass1LanguageServiceHost = tsvfs.createVirtualLanguageServiceHost(
		pass1System,
		[inputFileName],
		options,
		ts,
	).languageServiceHost;
	const pass1Program = ts.createProgram([inputFileName], options, pass1CompilerHost);
	const pass1SourceFile = pass1Program.getSourceFile(inputFileName);
	if (!pass1SourceFile) throw new Error(`Source file not found: ${inputFileName}`);

	const importPath = `${transformerPath}${transformerPath.includes("?") ? "&" : "?"}t=${Date.now()}`;
	console.debug("Loading transformer module", { transformerPath, importPath });
	const transformerModule = await import(/* @vite-ignore */ importPath);
	console.debug("Loaded transformer module exports", Object.keys(transformerModule));
	if (typeof transformerModule.default !== "function") {
		throw new Error(`Transformer module at ${transformerPath} must have a default-exported function`);
	}

	const transformerFn = transformerModule.default as TransformerFn;
	const transformResult = ts.transform(
		pass1SourceFile,
		[transformerFn({ program: pass1Program, languageServiceHost: pass1LanguageServiceHost })],
		options,
	);

	let transformedTsText: string;
	try {
		transformedTsText = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(
			transformResult.transformed[0] as ts.SourceFile,
		);
	} finally {
		transformResult.dispose();
	}

	// Replace the source in the VFS, then discard every pass-1 host/program object.
	fsMap.set(inputFileName, transformedTsText);

	// Pass 2 is intentionally built from fresh VFS objects so the transformed
	// declarations are parsed, bound, and type checked before declaration emit.
	const pass2System = tsvfs.createSystem(fsMap);
	const pass2VirtualHost = tsvfs.createVirtualCompilerHost(pass2System, options, ts);
	const pass2CompilerHost = pass2VirtualHost.compilerHost;
	const pass2Program = ts.createProgram([inputFileName], options, pass2CompilerHost);
	const pass2SourceFile = pass2Program.getSourceFile(inputFileName);
	if (!pass2SourceFile) throw new Error(`Transformed source file not found: ${inputFileName}`);
	
	const emitResult = pass2Program.emit();
	const diagnostics = ts.sortAndDeduplicateDiagnostics([
		//...ts.getPreEmitDiagnostics(pass2Program), 
		...emitResult.diagnostics
	]);

	if (diagnostics.length) {
		console.info(
			ts.formatDiagnosticsWithColorAndContext(diagnostics, {
				getCanonicalFileName: pass2Program.getCanonicalFileName,
				getCurrentDirectory: pass2Program.getCurrentDirectory,
				getNewLine: pass2CompilerHost.getNewLine,
			}),
		);
	}
	collectDiagnostics(diagnostics, errors, errorPositions);

	return {
		transformedTs: transformedTsText,
		emittedJs: pass2System.readFile(outputFileName(inputFileName, ".js")) || "",
		dts: pass2System.readFile(outputFileName(inputFileName, ".d.ts")) || "",
		structure: sourceFileAST(pass2SourceFile, pass2Program),
		errors,
		errorPositions,
		debugLogs,
		compilerOptions: options,
	};
}
