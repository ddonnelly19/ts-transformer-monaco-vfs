import ts from "typescript";
import { getFlagName, getFlagNames, isNode, isNotEmpty, stableStringify } from "./utils";
import { printNode } from "ts-morph";

interface SymbolJSON {
	flags: ts.SymbolFlags;
	escapedName: ts.__String;
	declarations: ts.Declaration[];
	valueDeclaration?: ts.Declaration;
	members: ts.SymbolTable;
	exports: ts.SymbolTable;
	globalExports: ts.SymbolTable;
	id: ts.SymbolId;
	mergeId: number;
	exportSymbol: ts.Symbol;
	constEnumOnlyModule: boolean | undefined;
	isReferenced: ts.SymbolFlags;
	lastAssignmentPos: number;
	isReplaceableByMethod: boolean;
	assignmentDeclarationMembers: Map<number, ts.Declaration>;
	name: string;
	getFlags(): ts.SymbolFlags;
	getEscapedName(): ts.__String;
	getName(): string;
	getDeclarations(): ts.Declaration[] | undefined;
	getDocumentationComment(typeChecker: ts.TypeChecker | undefined): ts.SymbolDisplayPart[];
	/** @internal */
	getContextualDocumentationComment(context: ts.Node | undefined, checker: ts.TypeChecker | undefined): ts.SymbolDisplayPart[];
	getJsDocTags(checker?: ts.TypeChecker): ts.JSDocTagInfo[];
	/** @internal */
	getContextualJsDocTags(context: ts.Node | undefined, checker: ts.TypeChecker | undefined): ts.JSDocTagInfo[];
}

/*declare module "typescript" {
	interface Symbol {
		toJSON(key: any): SymbolJSON
	}
}*/

/**
 * Converts a TypeScript compiler `ts.Symbol` to a plain object safe for
 * serialisation (e.g. `JSON.stringify`). The `parent` back-reference is
 * stripped to avoid circular references.
 *
 * @param sym - The compiler symbol to serialise.
 * @returns A shallow clone of `sym` with `parent` set to `undefined`.
 */
export function SymboltoJSON(sym: ts.Symbol) {
	var ret = {
		...sym,
		parent: undefined,
	};
	return ret;
}

/**
 * Converts a `Map` to a plain object keyed by stable JSON representations of
 * the map keys.
 *
 * @param m - The map to convert.
 * @returns A `Record`-like object whose keys are `stableStringify(key)`.
 */
function mapToJSON<K, V>(m: Map<K, V>) {
	return Object.fromEntries(Array.from(m.entries(), ([key, value]) => [typeof key == "string" ? key : stableStringify(key), value]));
}

/**
 * Converts a `Set` to a plain array for JSON serialisation.
 *
 * @param s - The set to convert.
 * @returns An array containing all values in insertion order.
 */
function setToJSON<T>(s: Set<T>) {
	return Array.from(s.values());
}

/**
 * Type guard: checks whether a value looks like a TypeScript compiler `ts.Symbol`.
 *
 * NOTE:
 * - `ts.Symbol` is an interface (not a runtime class), so `instanceof` isn't possible.
 * - This is a structural check; it can produce false positives if an object mimics the same shape.
 */
export function isTsSymbol(value: unknown): value is ts.Symbol {
	if (value == null || typeof value !== "object") return false;
	
	if (value.constructor.name == "SymbolObject")
		return true;
	const v = value as Partial<ts.Symbol> & Record<string, unknown>;

	// `flags` is required on ts.Symbol and is a number (enum)
	if (typeof v.flags !== "number") return false;

	// `escapedName` is required and is usually a string-like internal type.
	// In practice it's either a string or something string-coercible.
	if (!("escapedName" in v)) return false;

	// At least one of these usually exists in real Symbols.
	// (They are optional in the type, but commonly present.)
	const hasDeclarations =
		Array.isArray(v.declarations) || typeof (v as any).valueDeclaration === "object" || typeof (v as any).members === "object" || typeof (v as any).exports === "object";

	return hasDeclarations;
}

/**
 * Type guard to check if an unknown object is a ts.Type
 */
export function isTsType(obj: unknown): obj is ts.Type {
	return (obj as any).constructor.name == "TypeObject";
	/* || (
		typeof obj === "object" &&
		obj !== null &&
		!("kind" in obj) &&
		"id" in obj && 
		typeof obj.id === "number" &&
		"flags" in obj &&
		typeof obj.flags === "number" 
		// Differentiate from ts.Node (which uses .kind) and ts.Symbol (which uses .flags but has different methods)
		//typeof (obj as any).getApparentType === "function" &&
		//typeof (obj as any).getConstraint === "function"
	);*/
}

/**
 * JSON replacer (suitable as the second argument to `JSON.stringify`) that
 * collapses TypeScript compiler objects into readable plain values:
 *
 * - `Map` → object keyed by stable-stringified keys
 * - `Set` → array
 * - `Array` → spread copy
 * - `ts.Symbol` → stripped representation with flag names instead of raw numbers
 *
 * When processing a top-level symbol (`key === ""`) the `parent` reference is
 * included; nested symbols have `parent` omitted to break cycles.
 *
 * @param key - The JSON property key (empty string for the root value).
 * @param obj - The value being stringified.
 * @returns A JSON-safe representation of `obj`.
 */
function createSymbolReplacer(checker?: ts.TypeChecker) {
	const seen = new WeakSet<object>();

	return function symbolReplacer(key: any, obj: any) {
		if (obj === null || obj === undefined) return obj;

		if (typeof obj === "object") {
			if (seen.has(obj)) return undefined;
			seen.add(obj);

			if (obj instanceof Map) return mapToJSON(obj);
			if (obj instanceof Set) return setToJSON(obj);

			if (isNode(obj)) {
				return {
					kind: getFlagName(obj.kind, ts.SyntaxKind),
					flags: getFlagName(obj.flags, ts.NodeFlags),
					fileName: obj.getSourceFile().fileName,
					pos: obj.pos,
					end: obj.end,
					text: printNode(obj),
				};
			}
			
			if(isTsType(obj)) {		
				return {
					...obj,
					flags: getFlagName(obj.flags, ts.TypeFlags),
					symbol: undefined,
					checker: undefined,
					id: undefined,
					objectFlags: getFlagNames((obj as any).objectFlags, ts.ObjectFlags, ts.ObjectFlags.None),
					freshType: undefined
								
				}
			}

			if (isTsSymbol(obj)) {
				try {
					return {
						name: obj.name,
						escapedName: obj.escapedName,
						parent: undefined,
						flags: getFlagNames(obj.flags, ts.SymbolFlags, ts.SymbolFlags.None),
						//id: obj.id,
						//mergeId: obj.mergeId,
						//constEnumOnlyModule: !!obj.constEnumOnlyModule,
						type: checker?.getTypeOfSymbol(obj),
						members: obj.members,
						exports: obj.exports,
						globalExports: obj.globalExports,
						exportSymbol: obj.exportSymbol,
						isReferenced: obj.isReferenced ? getFlagNames(obj.isReferenced, ts.SymbolFlags, ts.SymbolFlags.None) : undefined,
						//lastAssignmentPos: obj.lastAssignmentPos,
						//isReplaceableByMethod: !!obj.isReplaceableByMethod,
						//assignmentDeclarationMembers: obj.assignmentDeclarationMembers,
						declarations: obj.declarations,
						valueDeclaration: obj.valueDeclaration,
					};
				} catch (ex) {
					return undefined;
				}
			}
		}

		return obj;
	};
}

export function sourceFileAST(sourceFile: ts.SourceFile, program?: ts.Program) {
	const syms = [...(sourceFile.locals?.values() || []), sourceFile.symbol];

	console.log(syms);
	return syms ? JSON.stringify(syms, createSymbolReplacer(program?.getTypeChecker()), "\t") : "error";
}
