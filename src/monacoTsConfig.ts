// vite: import the d.ts as text

import tsTypes from "../@types/typescript.internal.d.ts?raw";
import utils from "./ts/utils.ts?raw";
import tsMorph from "../node_modules/ts-morph/lib/ts-morph.d.ts?raw";

/**
 * Configures Monaco Editor's TypeScript language service with the compiler
 * options, diagnostics settings, and extra ambient type libraries required by
 * the transformer playground.
 *
 * Registers the following virtual files in Monaco's VFS:
 * - `file:///typescript.d.ts` — full TypeScript compiler API typings
 * - `file:///ts-morph.d.ts` — ts-morph typings
 * - `file:///utils.ts` — shared transformer utilities
 * - `file:///ambient/ts-global.d.ts` — `import * as ts` re-export
 * - `file:///ambient/ts-global2.d.ts` — global `ts` and `factory` declarations
 *
 * Also attaches a JSON schema for `compilerOptions.json` pointing at the
 * SchemaStore TSConfig schema.
 *
 * @param monacoInstance - The Monaco Editor module instance, or `null` if not
 *   yet initialised. When `null` (or the TypeScript service is unavailable)
 *   the function is a no-op and returns `false`.
 * @returns `true` when configuration was applied successfully, `false` if the
 *   TypeScript language service was not ready.
 */
export function configureMonacoTs(monacoInstance: typeof import("monaco-editor") | null) {
	// vite: import all transformer files as raw text

	// prefer provided monaco instance (from @monaco-editor/react onMount)
	const mon = monacoInstance;

	const ts = mon?.typescript;

	if (!ts || !ts.typescriptDefaults) {
		//console.warn('TypeScript service not available yet')
		return false;
	}

	const defaults = ts.typescriptDefaults;

	defaults.setEagerModelSync(true);
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
		paths: {
			typescript: ["file:///typescript.d.ts"],
			//"@typescript/vfs": ["file:///./node_modules/@typescript/vfs/dist/index.d.ts"]
		},
		outDir: "dist",
		//"rootDir": "src",
		skipLibCheck: true,
	});

	defaults.setDiagnosticsOptions({
		noSemanticValidation: false,
		noSyntaxValidation: false,
	});

	defaults.addExtraLib(tsMorph, "file:///ts-morph.d.ts");
	defaults.addExtraLib(tsTypes, "file:///typescript.d.ts");

	// Ambient declaration: provide IntelliSense for global `ts` symbol
	defaults.addExtraLib(`import * as ts from "./typescript";`, "file:///ambient/ts-global.d.ts");
	defaults.addExtraLib(utils, "file:///utils.ts");
	defaults.addExtraLib(
		`
declare const ts: typeof import("typescript");
declare const factory: typeof ts["factory"];
`,
		`file:///ambient/ts-global2.d.ts`,
	);
	
	// 	const transformerLibs = import.meta.glob("../storage/transformers/**/*.{ts,js,d.ts}", {
	// 	query: "?raw",
	// 	import: "default",
	// 	eager: true,
	// }) as Record<string, string>;
	/*for (const [path, content] of Object.entries(transformerLibs)) {
		const fileName = path.split("/").pop()!;
		if (fileName != "transformers.ts" && fileName != "utils.ts") {
			const virtualPath = `file:///${path}`;

			defaults.addExtraLib(content, virtualPath);
		}
	}*/

	mon.json.jsonDefaults.setDiagnosticsOptions({
		validate: true,
		schemas: [
			{
				fileMatch: ["file://compilerOptions.json"],
				uri: "https://www.schemastore.org/tsconfig",
			},
		],
	});

	return true;
}
