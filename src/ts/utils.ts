import { Project } from "ts-morph";
import ts from "typescript";

export { applyRefactors, createTSMorphSourceFile, createTSMorphTransform } from "../ts-morph/tsmorphUtils";

export const factory = ts.factory;
/** A value that can be treated as JSDoc content: raw text, a compiler JSDoc node, or a single tag. */
type JSDocLike = string | ts.JSDoc | ts.JSDocTag;

/**
 * Narrows `arg` to `T`, returning `false` for `null`, `undefined`, empty
 * strings, and the literal strings `"undefined"` or `"null"`.
 *
 * @param arg - Value to test.
 * @returns `true` when `arg` is a meaningful, non-empty value.
 */
export function isNotEmpty<T>(arg: T | null | undefined): arg is T {
	if (arg == null || typeof arg == "undefined") return false;
	if (typeof arg == "string") {
		return arg.trim() != "" && arg.trim().toLowerCase() != "undefined" && arg.trim().toLowerCase() != "null";
	}
	return true;
}

/**
 * Inverse of {@link isNotEmpty}. Returns `true` when `arg` is empty, `null`,
 * or `undefined`.
 *
 * @param arg - Value to test.
 */
export function isEmpty(arg: any): arg is null | undefined {
	return !isNotEmpty(arg);
}

/**
 * Collects all leading comments (both real source ranges and synthetic ones)
 * from a TypeScript AST node and normalises them to plain text lines,
 * stripping `//`, `/*`, and `*` decorators.
 *
 * @param node - The AST node whose leading comments should be extracted.
 * @returns An array of trimmed, non-empty comment lines.
 */
export function getAllLeadingComments(node: ts.Node): string[] {
	function normalizeToJsDocLines(comments: string[]): string[] {
		const lines: string[] = [];
		for (const c of comments) {
			const trimmed = c.trim();
			if (trimmed.startsWith("//")) {
				const text = trimmed.replace(/^\/\/+/, "").trim();
				if (text) lines.push(text);
				continue;
			}
			if (trimmed.startsWith("/*")) {
				let body = trimmed.replace(/^\/\*+/, "").replace(/\*+\/$/, "");
				body = body.replace(/\r\n/g, "\n");
				for (let l of body.split("\n")) {
					l = l.replace(/^\s*\*\s?/, "").trimEnd();
					if (l.trim()) lines.push(l.trim());
				}
				continue;
			}
			if (trimmed) lines.push(trimmed);
		}
		return lines;
	}

	const texts: string[] = [];
	try {
		const fullText = node.getFullText();
		const ranges = ts.getLeadingCommentRanges(fullText, 0) ?? [];
		for (const r of ranges) {
			texts.push(fullText.substring(r.pos, r.end));
		}
	} catch (ex) {
		console.warn(ex);
	}
	for (const c of ts.getSyntheticLeadingComments(node) ?? []) {
		texts.push(c.kind === ts.SyntaxKind.MultiLineCommentTrivia ? `/*${c.text}*/` : `//${c.text}`);
	}
	//return texts;
	return normalizeToJsDocLines(texts);
}

/**
 * Formats an array of plain-text lines into the interior text of a JSDoc
 * block comment.
 *
 * A single line is returned inline (`* text `); multiple lines are returned
 * with leading `*` prefixes joined by newlines.
 *
 * @param lines - Plain-text content lines.
 * @returns A string suitable for use as the `text` of a synthetic
 *   `MultiLineCommentTrivia` node.
 */
export function makeJsDocText(lines: string[]) {
	function createSynthesizedComment(text: string): string {
		text = text.trim();
		if (text.startsWith("/**")) text = text.substring(3).trim();
		if (text.endsWith("*/")) text.substring(0, text.length - 2).trim();
		text = ` * ${text.trim()}`;
		/*return {
			text,
			pos: -1,
			end: -1,
			kind: ts.SyntaxKind.MultiLineCommentTrivia
		}*/
		return text;
	}
	if (lines.length == 1) return createSynthesizedComment(lines[0]!).trim() + " ";
	return ["*", ...lines.map(createSynthesizedComment), " "].join("\n");
	//return lines.length == 1 ? body.trim() : `*\n${body}\n `;
}



/**
 * Extracts the right-hand side / initializer expression from any
 * {@link TSAssignmentNode} variant.
 *
 * @param node - The assignment node, or `undefined`.
 * @returns The initializer expression, or `undefined` if none exists.
 */
export function TSgetInitializer(node: TSAssignmentNode | undefined) {
	if (!node) return undefined;
	if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) return node.initializer;
	if (ts.isAssignmentExpression(node) || ts.isBinaryExpression(node)) return node.right;
	if (ts.isSpreadAssignment(node)) return node.expression;
	if (ts.isShorthandPropertyAssignment(node)) return node.objectAssignmentInitializer;
	return undefined;
}

export const validProperty = /^[A-Za-z_$][A-Za-z0-9_$]*$/; ///^(?![0-9])[a-zA-Z0-9$_]+$/;

/** A string that is (or can be treated as) a valid TypeScript identifier, including dotted paths. */
export type IdentifierString = (string & ts.Identifier["escapedText"]) | string;

/**
 * Returns `true` when every dot-separated segment of `str` matches the valid
 * identifier regex `validProperty`.
 *
 * @param str - Value to test.
 * @returns Type guard narrowing `str` to {@link IdentifierString}.
 */
export function isValidIdentifier(str: any): str is IdentifierString {
	if (isEmpty(str)) return false;
	return `${str}`.split(".").every((a) => validProperty.test(a));
}

/**
 * Filters a mixed `NodeArray<ModifierLike>` down to only `ts.Modifier` nodes,
 * excluding decorators.
 *
 * @param modifiers - The raw modifier array from a declaration node.
 * @returns An array of pure `ts.Modifier` nodes, or `undefined` if none.
 */
export function getModifiers(modifiers?: ts.NodeArray<ts.ModifierLike>): ts.Modifier[] | undefined {
	if (!modifiers) return undefined;
	return modifiers
		.map((m) => {
			if (ts.isModifier(m)) return m;
			return undefined;
		})
		.filter((a) => !!a);
}
/**
 * Prints a TypeScript AST node (or returns a trimmed string as-is) using the
 * TypeScript printer.
 *
 * @param doc - The node to print, a pre-formatted string, or `undefined`.
 * @param printOptions - Optional printer options (default: keep comments).
 * @returns The printed source text, trimmed. Empty string for falsy input.
 */
export function printNode(doc?: string | ts.Node): string;
export function printNode(doc?: string | ts.Node, printOptions: ts.PrinterOptions = { removeComments: false }): string {
	if (!doc) return "";
	if (typeof doc == "string") return doc.trim();
	var sf = ts.factory.createSourceFile([doc as any], ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.None);
	var ret = ts.createPrinter(printOptions).printFile(sf);
	return ret.trim();
}

/**
 * Tests whether all bits in `value` are set in `flags`.
 *
 * @param flags - The bitfield to test.
 * @param value - The bitmask to look for.
 * @returns `true` if every bit in `value` is present in `flags`.
 */
export function hasFlags<T extends number>(flags: T, value: T): boolean {
	return (flags & value) === value;
}
/**
 * Tests whether at least one of the provided bitmasks is fully set in `flags`.
 *
 * @param flags - The bitfield to test.
 * @param value - One or more bitmasks; returns `true` if any match.
 */
export function hasAnyFlags<T extends number>(flags: T, ...value: T[]): boolean {
	return value.some((v) => hasFlags(flags, v));
}

/**
 * Creates a minimal in-memory `ts.Program` from a single source text string.
 *
 * Useful for one-off type-checking or analysis without a full VFS setup.
 *
 * @param sourceText - The TypeScript/JavaScript source code.
 * @param fileName - Virtual file name used inside the compiler host.
 * @param options - Compiler options (defaults to `ESNext` target).
 * @returns A `ts.Program` containing only the given file.
 */
export function createProgramFromSourceFile(sourceText: string, fileName: string = "input.ts", options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext }) {
	const host: ts.CompilerHost = {
		getSourceFile: (f, langVersion) => (f === fileName ? ts.createSourceFile(f, sourceText, langVersion, true) : undefined),
		useCaseSensitiveFileNames: () => false,
		fileExists: (f) => f === fileName,
		readFile: (f) => (f === fileName ? sourceText : ""),
		getDefaultLibFileName: (options) => ts.getDefaultLibFileName(options),
		writeFile: (fileName, text, writeByteOrderMark, onError, sourceFiles, data) => void 0,
		getCurrentDirectory: () => "",
		getCanonicalFileName: (fileName) => fileName,
		getNewLine: () => "\n",
	};

	return ts.createProgram([fileName], options, host);
}

export function isNode(value: any): value is ts.Node {
	return (
		!!value &&
		(value.constructor.name == "NodeObject" || ts.isSourceFile(value) || (typeof value.kind === "number" && typeof value.pos === "number" && typeof value.end === "number"))
	);
}

/**
 * Builds a `String.prototype.concat(...)` call expression in the AST.
 *
 * @param left - The receiver of `.concat()` — either an expression node or a
 *   string literal value.
 * @param right - One or more expressions to pass as concat arguments.
 * @returns A `ts.CallExpression` representing `left.concat(...right)`.
 */
export function createStringConcat(left: ts.Expression | string, right: ts.Expression | ts.Expression[]) {
	return ts.factory.createCallExpression(
		ts.factory.createPropertyAccessExpression(typeof left == "string" ? ts.factory.createStringLiteral(left) : left, "concat"),
		undefined,
		Array.isArray(right) ? right : [right],
	);
}

/**
 * Checks if a node's type is assignable to string.
 * Handles union and intersection types.
 * @param node - The AST node to check.
 * @param checker - The TypeScript TypeChecker instance.
 * @param strict - If true, all members (union or intersection) must be assignable to string.
 *                 If false, at least one member must be assignable.
 */
export function isNodeAssignableToString(node: ts.Node, checker: ts.TypeChecker, strict: boolean = false) {
	const nodeType = checker.getTypeAtLocation(node);

	// Helper to check a single type
	const checkType = (type: ts.Type) =>
		checker.isTypeAssignableTo(type, checker.getAnyType()) ||
		checker.isTypeAssignableTo(type, checker.getUnknownType()) ||
		checker.isTypeAssignableTo(type, checker.getStringType()) ||
		checker.isTypeAssignableTo(type, checker.getNumberType()) ||
		checker.isTypeAssignableTo(type, checker.getBooleanType());

	var ret = (function () {
		// Handle Union Types
		if (nodeType.isUnion()) {
			return strict ? nodeType.types.every(checkType) : nodeType.types.some(checkType);
		}

		// Handle Intersection Types
		if (nodeType.isIntersection()) {
			return strict ? nodeType.types.every(checkType) : nodeType.types.some(checkType);
		}

		// Handle normal types
		return checkType(nodeType);
	})();
	if (!ret) console.warn(`isNodeAssignableToString: ${printNode(node)}: ${checker.typeToString(nodeType)}: ${ret}`);
	return ret;
}

export type TSAssignmentNode =
	| ts.BinaryExpression
	| ts.PropertyAssignment
	| ts.ShorthandPropertyAssignment
	| ts.SpreadAssignment
	| ts.VariableDeclaration
	| ts.AssignmentExpression<ts.EqualsToken>;

export type TSAssignmentTarget =
	| ts.Expression
	| ts.BindingName
	| ts.PropertyName
	| undefined;

/**
 * Returns the logical target associated with an assignment-like node.
 *
 * Notes:
 *
 * - VariableDeclaration returns its binding name.
 * - PropertyAssignment returns its property name.
 * - ShorthandPropertyAssignment returns its identifier.
 * - SpreadAssignment returns its spread expression. This is not a writable
 *   target, but it is the expression associated with the spread member.
 * - Binary and assignment expressions return their left-hand side.
 */
export function TSgetIdentifier(
	node: TSAssignmentNode | undefined,
): TSAssignmentTarget {
	if (!node) {
		return undefined;
	}

	if (ts.isVariableDeclaration(node)) {
		return node.name;
	}

	if (ts.isPropertyAssignment(node)) {
		return node.name;
	}

	if (ts.isShorthandPropertyAssignment(node)) {
		return node.name;
	}

	if (ts.isSpreadAssignment(node)) {
		return node.expression;
	}

	if (
		ts.isAssignmentExpression(node) ||
		(
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind ===
				ts.SyntaxKind.EqualsToken
		)
	) {
		return node.left;
	}

	return undefined;
}

/**
 * Determines whether a node is itself contained within a TypeScript or
 * JavaScript const assertion.
 *
 * TypeScript:
 *
 *     value as const
 *
 * JavaScript:
 *
 *     /** @type {const} *\/ (value)
 *
 * The ancestor walk stops at statement boundaries so a const assertion in
 * one statement cannot affect candidate expressions in another statement.
 */
export function isAsConstExpression(
	node: ts.Node | undefined,
): boolean {
	if (!node) {
		return false;
	}

	return (
		ts.findAncestor(node, (ancestor) => {
			if (ts.isStatement(ancestor)) {
				return "quit";
			}

			if (
				ts.isAsExpression(ancestor) &&
				ts.isConstTypeReference(ancestor.type)
			) {
				return true;
			}

			if (
				ts.isParenthesizedExpression(ancestor) &&
				hasJSDocConstTypeAssertion(ancestor)
			) {
				return true;
			}

			return false;
		}) !== undefined
	);
}

/**
 * Determines whether a node is one of the assignment-like constructs used by
 * the transformer.
 *
 * Variable declarations only qualify when they belong to a normal
 * VariableStatement. Declarations inside for, for-in, and for-of statements
 * are excluded.
 */
export function TSisAssignment(
	node: ts.Node | undefined,
): node is TSAssignmentNode {
	if (!node) {
		return false;
	}

	if (
		ts.isSpreadAssignment(node) ||
		ts.isPropertyAssignment(node) ||
		ts.isShorthandPropertyAssignment(node)
	) {
		return true;
	}

	if (ts.isVariableDeclaration(node)) {
		const declarationList = node.parent;
		const declarationOwner = declarationList.parent;

		return (
			ts.isVariableDeclarationList(declarationList) &&
			ts.isVariableStatement(declarationOwner)
		);
	}

	if (ts.isAssignmentExpression(node, false)) {
		return true;
	}

	return (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind ===
			ts.SyntaxKind.EqualsToken
	);
}

/**
 * Determines whether a variable declaration uses const.
 */
export function TSisConstVariableDeclaration(
	node: ts.Node | undefined,
): node is ts.VariableDeclaration {
	if (
		!node ||
		!ts.isVariableDeclaration(node)
	) {
		return false;
	}

	const declarationList = node.parent;

	return (
		ts.isVariableDeclarationList(declarationList) &&
		(declarationList.flags & ts.NodeFlags.Const) !== 0
	);
}

/**
 * Finds the first parent that is not a ParenthesizedExpression.
 */
export function TSgetNonParenthesizedParent(
	node: ts.Node,
): ts.Node | undefined {
	let parent = node.parent;

	while (
		parent &&
		ts.isParenthesizedExpression(parent)
	) {
		parent = parent.parent;
	}

	return parent;
}

/**
 * Walks outward from an expression and returns the outermost parenthesized
 * expression that contains it.
 */
export function TSgetOutermostParenthesizedExpression(
	expression: ts.Expression,
): ts.Expression {
	let current = expression;

	while (
		current.parent &&
		ts.isParenthesizedExpression(current.parent) &&
		current.parent.expression === current
	) {
		current = current.parent;
	}

	return current;
}

/**
 * Detects:
 *
 *     /** @type {const} *\/ (expression)
 *
 * Depending on parser attachment behavior, the JSDoc may be associated with
 * the parenthesized expression or with its inner expression. Both locations
 * are checked.
 */
function hasJSDocConstTypeAssertion(
	node: ts.ParenthesizedExpression,
): boolean {
	return (
		hasJSDocConstTypeTag(node) ||
		hasJSDocConstTypeTag(node.expression)
	);
}

function hasJSDocConstTypeTag(
	node: ts.Node,
): boolean {
	if (!ts.canHaveJSDoc(node)) {
		return false;
	}

	return ts.getJSDocTags(node).some(
		(tag) =>
			ts.isJSDocTypeTag(tag) &&
			tag.typeExpression !== undefined &&
			ts.isConstTypeReference(
				tag.typeExpression.type,
			),
	);
}
``

/**
 * Creates a shallow, mutable clone of the given AST node with the
 * `Synthesized` flag set and `pos`/`end` reset to `-1`.
 *
 * Unlike `ts.getMutableClone` this preserves the prototype chain and copies
 * only own-enumerable properties.
 *
 * @param node - The node to clone.
 * @returns A mutable copy of `node`.
 */
export function getMutableClone<T extends ts.Node>(node: T) {
	// We don't use "clone" from core.ts here, as we need to preserve the prototype chain of
	// the original node. We also need to exclude specific properties and only include own-
	// properties (to skip members already defined on the shared prototype).
	if (node === undefined) {
		return node;
	}
	var proto = Object.getPrototypeOf(node);
	var clone = Object.create(proto);
	for (var key of Object.getOwnPropertyNames(node)) {
		clone[key] = (node as any)[key];
	}
	updateValue(clone, "flags", ts.NodeFlags.Synthesized | node.flags);
	updateValue(clone, "pos", -1);
	updateValue(clone, "end", -1);
	return clone;
}

/**
 * Prints a node (or returns a string as-is) with comments preserved, using
 * the `JSDoc` node flag so that leading comment trivia is emitted correctly.
 *
 * @param doc - A pre-formatted string or an AST node.
 * @returns Trimmed source text with comments intact.
 */
export function printJSDocLike(doc: string | ts.Node) {
	if (typeof doc == "string") return doc.trim();
	var sf = ts.factory.createSourceFile([doc as any], ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.JSDoc);
	var ret = ts.createPrinter({ removeComments: false }).printFile(sf);
	return ret.trim();
}

function updateValue<T, K extends keyof T>(obj: T, key: K, value: T[K]) {
	var prop = Object.getOwnPropertyDescriptor(obj, key);
	if (prop?.writable) obj[key] = value;
	else
		Object.defineProperty(obj, key, {
			...prop,
			value: value,
		});
	return obj;
}

/**
 * Attaches a synthetic JSDoc block comment to `node`, replacing any existing
 * leading comments.
 *
 * @param node - The AST node to annotate.
 * @param jsDocLines - Plain-text lines for the JSDoc body (see {@link makeJsDocText}).
 * @returns A mutable clone of `node` with the JSDoc comment attached.
 */
export function applyJsDoc<T extends ts.Node>(node: T, jsDocLines: string[]): T {
	var updated = updateNode(node);
	ts.setEmitFlags(updated, ts.EmitFlags.NoLeadingComments);
	ts.setSyntheticLeadingComments(updated, []);
	if (jsDocLines.length > 0) ts.addSyntheticLeadingComment(updated, ts.SyntaxKind.MultiLineCommentTrivia, makeJsDocText(jsDocLines), true);
	return updated;
}

export function createNode<T extends ts.Node>(node: T): T {
	// Declarations -------------------------------------------------------------
	if (ts.isSourceFile(node)) {
		return ts.factory.updateSourceFile(
			node,
			node.statements,
			node.isDeclarationFile,
			node.referencedFiles,
			node.typeReferenceDirectives,
			node.hasNoDefaultLib,
			node.libReferenceDirectives,
		) as unknown as T;
	}
	if (ts.isVariableStatement(node)) {
		return ts.factory.createVariableStatement(node.modifiers, node.declarationList) as unknown as T;
	}
	if (ts.isVariableDeclarationList(node)) {
		return ts.factory.createVariableDeclarationList(node.declarations) as unknown as T;
	}
	if (ts.isVariableDeclaration(node)) {
		return ts.factory.createVariableDeclaration(node.name, node.exclamationToken, node.type, node.initializer) as unknown as T;
	}
	if (ts.isFunctionDeclaration(node)) {
		return ts.factory.createFunctionDeclaration(node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, node.body) as unknown as T;
	}
	if (ts.isClassDeclaration(node)) {
		return ts.factory.createClassDeclaration(node.modifiers, node.name, node.typeParameters, node.heritageClauses, node.members) as unknown as T;
	}
	if (ts.isInterfaceDeclaration(node)) {
		return ts.factory.createInterfaceDeclaration(node.modifiers, node.name, node.typeParameters, node.heritageClauses, node.members) as unknown as T;
	}
	if (ts.isTypeAliasDeclaration(node)) {
		return ts.factory.createTypeAliasDeclaration(node.modifiers, node.name, node.typeParameters, node.type) as unknown as T;
	}
	if (ts.isEnumDeclaration(node)) {
		return ts.factory.createEnumDeclaration(node.modifiers, node.name, node.members) as unknown as T;
	}
	if (ts.isModuleDeclaration(node)) {
		return ts.factory.createModuleDeclaration(node.modifiers, node.name, node.body) as unknown as T;
	}
	if (ts.isImportDeclaration(node)) {
		return ts.factory.createImportDeclaration(node.modifiers, node.importClause, node.moduleSpecifier, node.assertClause) as unknown as T;
	}
	if (ts.isImportClause(node)) {
		return ts.factory.createImportClause(node.isTypeOnly, node.name, node.namedBindings) as unknown as T;
	}
	if (ts.isNamespaceImport(node)) {
		return ts.factory.createNamespaceImport(node.name) as unknown as T;
	}
	if (ts.isNamedImports(node)) {
		return ts.factory.createNamedImports(node.elements) as unknown as T;
	}
	if (ts.isImportSpecifier(node)) {
		return ts.factory.createImportSpecifier(node.isTypeOnly, node.propertyName, node.name) as unknown as T;
	}
	if (ts.isExportDeclaration(node)) {
		return ts.factory.createExportDeclaration(node.modifiers, node.isTypeOnly, node.exportClause, node.moduleSpecifier, node.assertClause) as unknown as T;
	}
	if (ts.isNamedExports(node)) {
		return ts.factory.createNamedExports(node.elements) as unknown as T;
	}
	if (ts.isExportSpecifier(node)) {
		return ts.factory.createExportSpecifier(node.isTypeOnly, node.propertyName, node.name) as unknown as T;
	}
	if (ts.isHeritageClause(node)) {
		return ts.factory.createHeritageClause(node.token, node.types) as unknown as T;
	}
	if (ts.isExpressionWithTypeArguments(node)) {
		return ts.factory.createExpressionWithTypeArguments(node.expression, node.typeArguments) as unknown as T;
	}

	// Class Members ------------------------------------------------------------
	if (ts.isConstructorDeclaration(node)) {
		return ts.factory.createConstructorDeclaration(node.modifiers, node.parameters, node.body) as unknown as T;
	}
	if (ts.isMethodDeclaration(node)) {
		return ts.factory.createMethodDeclaration(
			node.modifiers,
			node.asteriskToken,
			node.name,
			node.questionToken,
			node.typeParameters,
			node.parameters,
			node.type,
			node.body,
		) as unknown as T;
	}
	if (ts.isGetAccessorDeclaration(node)) {
		return ts.factory.createGetAccessorDeclaration(node.modifiers, node.name, node.parameters, node.type, node.body) as unknown as T;
	}
	if (ts.isSetAccessorDeclaration(node)) {
		return ts.factory.createSetAccessorDeclaration(node.modifiers, node.name, node.parameters, node.body) as unknown as T;
	}
	if (ts.isPropertyDeclaration(node)) {
		return ts.factory.createPropertyDeclaration(node.modifiers, node.name, node.questionToken, node.type, node.initializer) as unknown as T;
	}
	if (ts.isPropertySignature(node)) {
		return ts.factory.createPropertySignature(node.modifiers, node.name, node.questionToken, node.type) as unknown as T;
	}
	if (ts.isMethodSignature(node)) {
		return ts.factory.createMethodSignature(node.modifiers, node.name, node.questionToken, node.typeParameters, node.parameters, node.type) as unknown as T;
	}

	// Statements ---------------------------------------------------------------
	if (ts.isBlock(node)) {
		return ts.factory.createBlock(node.statements) as unknown as T;
	}
	if (ts.isEmptyStatement(node)) {
		return ts.factory.createEmptyStatement() as unknown as T;
	}
	if (ts.isReturnStatement(node)) {
		return ts.factory.createReturnStatement(node.expression) as unknown as T;
	}
	if (ts.isIfStatement(node)) {
		return ts.factory.createIfStatement(node.expression, node.thenStatement, node.elseStatement) as unknown as T;
	}
	if (ts.isForStatement(node)) {
		return ts.factory.createForStatement(node.initializer, node.condition, node.incrementor, node.statement) as unknown as T;
	}
	if (ts.isForInStatement(node)) {
		return ts.factory.createForInStatement(node.initializer, node.expression, node.statement) as unknown as T;
	}
	if (ts.isForOfStatement(node)) {
		return ts.factory.createForOfStatement(node.awaitModifier, node.initializer, node.expression, node.statement) as unknown as T;
	}
	if (ts.isWhileStatement(node)) {
		return ts.factory.createWhileStatement(node.expression, node.statement) as unknown as T;
	}
	if (ts.isDoStatement(node)) {
		return ts.factory.createDoStatement(node.statement, node.expression) as unknown as T;
	}
	if (ts.isSwitchStatement(node)) {
		return ts.factory.createSwitchStatement(node.expression, node.caseBlock) as unknown as T;
	}
	if (ts.isCaseBlock(node)) {
		return ts.factory.createCaseBlock(node.clauses) as unknown as T;
	}
	if (ts.isCaseClause(node)) {
		return ts.factory.createCaseClause(node.expression, node.statements) as unknown as T;
	}
	if (ts.isDefaultClause(node)) {
		return ts.factory.createDefaultClause(node.statements) as unknown as T;
	}
	if (ts.isBreakStatement(node)) {
		return ts.factory.createBreakStatement(node.label) as unknown as T;
	}
	if (ts.isContinueStatement(node)) {
		return ts.factory.createContinueStatement(node.label) as unknown as T;
	}
	if (ts.isTryStatement(node)) {
		return ts.factory.createTryStatement(node.tryBlock, node.catchClause, node.finallyBlock) as unknown as T;
	}
	if (ts.isCatchClause(node)) {
		return ts.factory.createCatchClause(node.variableDeclaration, node.block) as unknown as T;
	}
	if (ts.isThrowStatement(node)) {
		return ts.factory.createThrowStatement(node.expression) as unknown as T;
	}
	if (ts.isExpressionStatement(node)) {
		return ts.factory.createExpressionStatement(node.expression) as unknown as T;
	}
	if (ts.isLabeledStatement(node)) {
		return ts.factory.createLabeledStatement(node.label, node.statement) as unknown as T;
	}
	if (ts.isWithStatement(node)) {
		return ts.factory.createWithStatement(node.expression, node.statement) as unknown as T;
	}
	if (ts.isDebuggerStatement(node)) {
		return ts.factory.createDebuggerStatement() as unknown as T;
	}

	// Expressions --------------------------------------------------------------
	if (ts.isParenthesizedExpression(node)) {
		return ts.factory.createParenthesizedExpression(node.expression) as unknown as T;
	}
	if (ts.isCallExpression(node)) {
		return ts.factory.createCallExpression(node.expression, node.typeArguments, node.arguments) as unknown as T;
	}
	if (ts.isNewExpression(node)) {
		return ts.factory.createNewExpression(node.expression, node.typeArguments, node.arguments) as unknown as T;
	}
	if (ts.isPropertyAccessExpression(node)) {
		return ts.factory.createPropertyAccessExpression(node.expression, node.name) as unknown as T;
	}
	if (ts.isElementAccessExpression(node)) {
		return ts.factory.createElementAccessExpression(node.expression, node.argumentExpression) as unknown as T;
	}
	if (ts.isBinaryExpression(node)) {
		return ts.factory.createBinaryExpression(node.left, node.operatorToken, node.right) as unknown as T;
	}
	if (ts.isPrefixUnaryExpression(node)) {
		return ts.factory.createPrefixUnaryExpression(node.operator, node.operand) as unknown as T;
	}
	if (ts.isPostfixUnaryExpression(node)) {
		return ts.factory.createPostfixUnaryExpression(node.operand, node.operator) as unknown as T;
	}
	if (ts.isConditionalExpression(node)) {
		return ts.factory.createConditionalExpression(node.condition, node.questionToken, node.whenTrue, node.colonToken, node.whenFalse) as unknown as T;
	}
	if (ts.isTemplateExpression(node)) {
		return ts.factory.createTemplateExpression(node.head, node.templateSpans) as unknown as T;
	}
	if (ts.isTaggedTemplateExpression(node)) {
		return ts.factory.createTaggedTemplateExpression(node.tag, node.typeArguments, node.template) as unknown as T;
	}
	if (ts.isTemplateSpan(node)) {
		return ts.factory.createTemplateSpan(node.expression, node.literal) as unknown as T;
	}
	if (ts.isArrayLiteralExpression(node)) {
		return ts.factory.createArrayLiteralExpression(node.elements) as unknown as T;
	}
	if (ts.isObjectLiteralExpression(node)) {
		return ts.factory.createObjectLiteralExpression(node.properties) as unknown as T;
	}
	if (ts.isPropertyAssignment(node)) {
		return ts.factory.createPropertyAssignment(node.name, node.initializer) as unknown as T;
	}
	if (ts.isShorthandPropertyAssignment(node)) {
		return ts.factory.createShorthandPropertyAssignment(node.name, node.objectAssignmentInitializer) as unknown as T;
	}
	if (ts.isSpreadAssignment(node)) {
		return ts.factory.createSpreadAssignment(node.expression) as unknown as T;
	}
	if (ts.isSpreadElement(node)) {
		return ts.factory.createSpreadElement(node.expression) as unknown as T;
	}
	if (ts.isArrowFunction(node)) {
		return ts.factory.createArrowFunction(node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, node.body) as unknown as T;
	}
	if (ts.isYieldExpression(node)) {
		return ts.factory.createYieldExpression(node.asteriskToken, node.expression) as unknown as T;
	}
	if (ts.isAwaitExpression(node)) {
		return ts.factory.createAwaitExpression(node.expression) as unknown as T;
	}

	// JSX ----------------------------------------------------------------------
	if (ts.isJsxElement(node)) {
		return ts.factory.createJsxElement(node.openingElement, node.children, node.closingElement) as unknown as T;
	}
	if (ts.isJsxSelfClosingElement(node)) {
		return ts.factory.createJsxSelfClosingElement(node.tagName, node.typeArguments, node.attributes) as unknown as T;
	}
	if (ts.isJsxOpeningElement(node)) {
		return ts.factory.createJsxOpeningElement(node.tagName, node.typeArguments, node.attributes) as unknown as T;
	}
	if (ts.isJsxClosingElement(node)) {
		return ts.factory.createJsxClosingElement(node.tagName) as unknown as T;
	}
	if (ts.isJsxFragment(node)) {
		return ts.factory.createJsxFragment(node.openingFragment, node.children, node.closingFragment) as unknown as T;
	}
	if (ts.isJsxOpeningFragment(node)) {
		return ts.factory.createJsxOpeningFragment() as unknown as T;
	}
	//if (ts.isJsxClosingFragment(node)) {
	//	return ts.factory.createJsxClosingElement(node) as T;
	//}
	if (ts.isJsxAttribute(node)) {
		return ts.factory.createJsxAttribute(node.name, node.initializer) as unknown as T;
	}
	if (ts.isJsxAttributes(node)) {
		return ts.factory.createJsxAttributes(node.properties) as unknown as T;
	}
	if (ts.isJsxExpression(node)) {
		return ts.factory.createJsxExpression(node.dotDotDotToken, node.expression) as unknown as T;
	}

	// Types --------------------------------------------------------------------
	if (ts.isTypeReferenceNode(node)) {
		return ts.factory.createTypeReferenceNode(node.typeName, node.typeArguments) as unknown as T;
	}
	if (ts.isUnionTypeNode(node)) {
		return ts.factory.createUnionTypeNode(node.types) as unknown as T;
	}
	if (ts.isIntersectionTypeNode(node)) {
		return ts.factory.createIntersectionTypeNode(node.types) as unknown as T;
	}
	if (ts.isArrayTypeNode(node)) {
		return ts.factory.createArrayTypeNode(node.elementType) as unknown as T;
	}
	if (ts.isTupleTypeNode(node)) {
		return ts.factory.createTupleTypeNode(node.elements) as unknown as T;
	}
	if (ts.isTypeLiteralNode(node)) {
		return ts.factory.createTypeLiteralNode(node.members) as unknown as T;
	}
	if (ts.isFunctionTypeNode(node)) {
		return ts.factory.createFunctionTypeNode(node.typeParameters, node.parameters, node.type) as unknown as T;
	}
	if (ts.isConstructorTypeNode(node)) {
		return ts.factory.createConstructorTypeNode(node.modifiers, node.typeParameters, node.parameters, node.type) as unknown as T;
	}
	if (ts.isIndexedAccessTypeNode(node)) {
		return ts.factory.createIndexedAccessTypeNode(node.objectType, node.indexType) as unknown as T;
	}
	if (ts.isTypeOperatorNode(node)) {
		return ts.factory.createTypeOperatorNode(node.operator, node.type) as unknown as T;
	}
	if (ts.isMappedTypeNode(node)) {
		return ts.factory.createMappedTypeNode(node.readonlyToken, node.typeParameter, node.nameType, node.questionToken, node.type, node.members) as unknown as T;
	}
	if (ts.isConditionalTypeNode(node)) {
		return ts.factory.createConditionalTypeNode(node.checkType, node.extendsType, node.trueType, node.falseType) as unknown as T;
	}
	if (ts.isTemplateLiteralTypeNode(node)) {
		return ts.factory.createTemplateLiteralType(node.head, node.templateSpans) as unknown as T;
	}
	if (ts.isTypePredicateNode(node)) {
		return ts.factory.createTypePredicateNode(node.assertsModifier, node.parameterName, node.type) as unknown as T;
	}
	if (ts.isInferTypeNode(node)) {
		return ts.factory.createInferTypeNode(node.typeParameter) as unknown as T;
	}

	// Signatures & Parameters --------------------------------------------------
	if (ts.isTypeParameterDeclaration(node)) {
		return ts.factory.createTypeParameterDeclaration(node.modifiers, node.name, node.constraint, node.default) as unknown as T;
	}
	if (ts.isParameter(node)) {
		return ts.factory.createParameterDeclaration(node.modifiers, node.dotDotDotToken, node.name, node.questionToken, node.type, node.initializer) as unknown as T;
	}

	// Imports/Exports & Misc ---------------------------------------------------
	if (ts.isDecorator(node)) {
		return ts.factory.createDecorator(node.expression) as unknown as T;
	}
	if (ts.isModifier(node)) {
		// Modifiers are tokens; factory has create but not update for tokens—return as is.
		return node;
	}
	if (ts.isComputedPropertyName(node)) {
		return ts.factory.createComputedPropertyName(node.expression) as unknown as T;
	}
	if (ts.isIndexSignatureDeclaration(node)) {
		return ts.factory.createIndexSignature(node.modifiers, node.parameters, node.type) as unknown as T;
	}
	if (ts.isCallSignatureDeclaration(node)) {
		return ts.factory.createCallSignature(node.typeParameters, node.parameters, node.type) as unknown as T;
	}
	if (ts.isConstructSignatureDeclaration(node)) {
		return ts.factory.createConstructSignature(node.typeParameters, node.parameters, node.type) as unknown as T;
	}

	// Fallback: no update function handled; return original node.
	updateValue(node, "pos", -1);
	updateValue(node, "end", -1);
	if (ts.hasJSDocNodes(node)) node.jsDoc = undefined;
	return node;
}

/**
 * Update a node using the specific ts.factory.updateXxx function for its kind.
 * If no update function is available/implemented here, returns the input node.
 *
 * IMPORTANT:
 * - This function preserves the original shape (same fields) but returns a fresh node instance.
 * - It does not change anything itself—you should modify the arguments you pass in before calling this.
 * - For performance and correctness, prefer using updateXxx for the exact kind you’re changing.
 */
export function updateNode<T extends ts.Node>(node: T): T {
	// Declarations -------------------------------------------------------------
	if (ts.isSourceFile(node)) {
		return ts.factory.updateSourceFile(
			node,
			node.statements,
			node.isDeclarationFile,
			node.referencedFiles,
			node.typeReferenceDirectives,
			node.hasNoDefaultLib,
			node.libReferenceDirectives,
		) as unknown as T;
	}
	if (ts.isVariableStatement(node)) {
		return ts.factory.updateVariableStatement(node, node.modifiers, node.declarationList) as unknown as T;
	}
	if (ts.isVariableDeclarationList(node)) {
		return ts.factory.updateVariableDeclarationList(node, node.declarations) as unknown as T;
	}
	if (ts.isVariableDeclaration(node)) {
		return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, node.initializer) as unknown as T;
	}
	if (ts.isFunctionDeclaration(node)) {
		return ts.factory.updateFunctionDeclaration(
			node,
			node.modifiers,
			node.asteriskToken,
			node.name,
			node.typeParameters,
			node.parameters,
			node.type,
			node.body,
		) as unknown as T;
	}
	if (ts.isClassDeclaration(node)) {
		return ts.factory.updateClassDeclaration(node, node.modifiers, node.name, node.typeParameters, node.heritageClauses, node.members) as unknown as T;
	}
	if (ts.isInterfaceDeclaration(node)) {
		return ts.factory.updateInterfaceDeclaration(node, node.modifiers, node.name, node.typeParameters, node.heritageClauses, node.members) as unknown as T;
	}
	if (ts.isTypeAliasDeclaration(node)) {
		return ts.factory.updateTypeAliasDeclaration(node, node.modifiers, node.name, node.typeParameters, node.type) as unknown as T;
	}
	if (ts.isEnumDeclaration(node)) {
		return ts.factory.updateEnumDeclaration(node, node.modifiers, node.name, node.members) as unknown as T;
	}
	if (ts.isModuleDeclaration(node)) {
		return ts.factory.updateModuleDeclaration(node, node.modifiers, node.name, node.body) as unknown as T;
	}
	if (ts.isImportDeclaration(node)) {
		return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, node.moduleSpecifier, node.assertClause) as unknown as T;
	}
	if (ts.isImportClause(node)) {
		return ts.factory.updateImportClause(node, node.isTypeOnly, node.name, node.namedBindings) as unknown as T;
	}
	if (ts.isNamespaceImport(node)) {
		return ts.factory.updateNamespaceImport(node, node.name) as unknown as T;
	}
	if (ts.isNamedImports(node)) {
		return ts.factory.updateNamedImports(node, node.elements) as unknown as T;
	}
	if (ts.isImportSpecifier(node)) {
		return ts.factory.updateImportSpecifier(node, node.isTypeOnly, node.propertyName, node.name) as unknown as T;
	}
	if (ts.isExportDeclaration(node)) {
		return ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, node.moduleSpecifier, node.assertClause) as unknown as T;
	}
	if (ts.isNamedExports(node)) {
		return ts.factory.updateNamedExports(node, node.elements) as unknown as T;
	}
	if (ts.isExportSpecifier(node)) {
		return ts.factory.updateExportSpecifier(node, node.isTypeOnly, node.propertyName, node.name) as unknown as T;
	}
	if (ts.isHeritageClause(node)) {
		return ts.factory.updateHeritageClause(node, node.types) as unknown as T;
	}
	if (ts.isExpressionWithTypeArguments(node)) {
		return ts.factory.updateExpressionWithTypeArguments(node, node.expression, node.typeArguments) as unknown as T;
	}

	// Class Members ------------------------------------------------------------
	if (ts.isConstructorDeclaration(node)) {
		return ts.factory.updateConstructorDeclaration(node, node.modifiers, node.parameters, node.body) as unknown as T;
	}
	if (ts.isMethodDeclaration(node)) {
		return ts.factory.updateMethodDeclaration(
			node,
			node.modifiers,
			node.asteriskToken,
			node.name,
			node.questionToken,
			node.typeParameters,
			node.parameters,
			node.type,
			node.body,
		) as unknown as T;
	}
	if (ts.isGetAccessorDeclaration(node)) {
		return ts.factory.updateGetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, node.type, node.body) as unknown as T;
	}
	if (ts.isSetAccessorDeclaration(node)) {
		return ts.factory.updateSetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, node.body) as unknown as T;
	}
	if (ts.isPropertyDeclaration(node)) {
		return ts.factory.updatePropertyDeclaration(node, node.modifiers, node.name, node.questionToken, node.type, node.initializer) as unknown as T;
	}
	if (ts.isPropertySignature(node)) {
		return ts.factory.updatePropertySignature(node, node.modifiers, node.name, node.questionToken, node.type) as unknown as T;
	}
	if (ts.isMethodSignature(node)) {
		return ts.factory.updateMethodSignature(node, node.modifiers, node.name, node.questionToken, node.typeParameters, node.parameters, node.type) as unknown as T;
	}

	// Statements ---------------------------------------------------------------
	if (ts.isBlock(node)) {
		return ts.factory.updateBlock(node, node.statements) as unknown as T;
	}
	if (ts.isEmptyStatement(node)) {
		return ts.factory.createEmptyStatement() as unknown as T;
	}
	if (ts.isReturnStatement(node)) {
		return ts.factory.updateReturnStatement(node, node.expression) as unknown as T;
	}
	if (ts.isIfStatement(node)) {
		return ts.factory.updateIfStatement(node, node.expression, node.thenStatement, node.elseStatement) as unknown as T;
	}
	if (ts.isForStatement(node)) {
		return ts.factory.updateForStatement(node, node.initializer, node.condition, node.incrementor, node.statement) as unknown as T;
	}
	if (ts.isForInStatement(node)) {
		return ts.factory.updateForInStatement(node, node.initializer, node.expression, node.statement) as unknown as T;
	}
	if (ts.isForOfStatement(node)) {
		return ts.factory.updateForOfStatement(node, node.awaitModifier, node.initializer, node.expression, node.statement) as unknown as T;
	}
	if (ts.isWhileStatement(node)) {
		return ts.factory.updateWhileStatement(node, node.expression, node.statement) as unknown as T;
	}
	if (ts.isDoStatement(node)) {
		return ts.factory.updateDoStatement(node, node.statement, node.expression) as unknown as T;
	}
	if (ts.isSwitchStatement(node)) {
		return ts.factory.updateSwitchStatement(node, node.expression, node.caseBlock) as unknown as T;
	}
	if (ts.isCaseBlock(node)) {
		return ts.factory.updateCaseBlock(node, node.clauses) as unknown as T;
	}
	if (ts.isCaseClause(node)) {
		return ts.factory.updateCaseClause(node, node.expression, node.statements) as unknown as T;
	}
	if (ts.isDefaultClause(node)) {
		return ts.factory.updateDefaultClause(node, node.statements) as unknown as T;
	}
	if (ts.isBreakStatement(node)) {
		return ts.factory.updateBreakStatement(node, node.label) as unknown as T;
	}
	if (ts.isContinueStatement(node)) {
		return ts.factory.updateContinueStatement(node, node.label) as unknown as T;
	}
	if (ts.isTryStatement(node)) {
		return ts.factory.updateTryStatement(node, node.tryBlock, node.catchClause, node.finallyBlock) as unknown as T;
	}
	if (ts.isCatchClause(node)) {
		return ts.factory.updateCatchClause(node, node.variableDeclaration, node.block) as unknown as T;
	}
	if (ts.isThrowStatement(node)) {
		return ts.factory.updateThrowStatement(node, node.expression) as unknown as T;
	}
	if (ts.isExpressionStatement(node)) {
		return ts.factory.updateExpressionStatement(node, node.expression) as unknown as T;
	}
	if (ts.isLabeledStatement(node)) {
		return ts.factory.updateLabeledStatement(node, node.label, node.statement) as unknown as T;
	}
	if (ts.isWithStatement(node)) {
		return ts.factory.updateWithStatement(node, node.expression, node.statement) as unknown as T;
	}
	if (ts.isDebuggerStatement(node)) {
		return ts.factory.createDebuggerStatement() as unknown as T;
	}

	// Expressions --------------------------------------------------------------
	if (ts.isParenthesizedExpression(node)) {
		return ts.factory.updateParenthesizedExpression(node, node.expression) as unknown as T;
	}
	if (ts.isCallExpression(node)) {
		return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, node.arguments) as unknown as T;
	}
	if (ts.isNewExpression(node)) {
		return ts.factory.updateNewExpression(node, node.expression, node.typeArguments, node.arguments) as unknown as T;
	}
	if (ts.isPropertyAccessExpression(node)) {
		return ts.factory.updatePropertyAccessExpression(node, node.expression, node.name) as unknown as T;
	}
	if (ts.isElementAccessExpression(node)) {
		return ts.factory.updateElementAccessExpression(node, node.expression, node.argumentExpression) as unknown as T;
	}
	if (ts.isBinaryExpression(node)) {
		return ts.factory.updateBinaryExpression(node, node.left, node.operatorToken, node.right) as unknown as T;
	}
	if (ts.isPrefixUnaryExpression(node)) {
		return ts.factory.updatePrefixUnaryExpression(node, node.operand) as unknown as T;
	}
	if (ts.isPostfixUnaryExpression(node)) {
		return ts.factory.updatePostfixUnaryExpression(node, node.operand) as unknown as T;
	}
	if (ts.isConditionalExpression(node)) {
		return ts.factory.updateConditionalExpression(node, node.condition, node.questionToken, node.whenTrue, node.colonToken, node.whenFalse) as unknown as T;
	}
	if (ts.isTemplateExpression(node)) {
		return ts.factory.updateTemplateExpression(node, node.head, node.templateSpans) as unknown as T;
	}
	if (ts.isTaggedTemplateExpression(node)) {
		return ts.factory.updateTaggedTemplateExpression(node, node.tag, node.typeArguments, node.template) as unknown as T;
	}
	if (ts.isTemplateSpan(node)) {
		return ts.factory.updateTemplateSpan(node, node.expression, node.literal) as unknown as T;
	}
	if (ts.isArrayLiteralExpression(node)) {
		return ts.factory.updateArrayLiteralExpression(node, node.elements) as unknown as T;
	}
	if (ts.isObjectLiteralExpression(node)) {
		return ts.factory.updateObjectLiteralExpression(node, node.properties) as unknown as T;
	}
	if (ts.isPropertyAssignment(node)) {
		return ts.factory.updatePropertyAssignment(node, node.name, node.initializer) as unknown as T;
	}
	if (ts.isShorthandPropertyAssignment(node)) {
		return ts.factory.updateShorthandPropertyAssignment(node, node.name, node.objectAssignmentInitializer) as unknown as T;
	}
	if (ts.isSpreadAssignment(node)) {
		return ts.factory.updateSpreadAssignment(node, node.expression) as unknown as T;
	}
	if (ts.isSpreadElement(node)) {
		return ts.factory.updateSpreadElement(node, node.expression) as unknown as T;
	}
	if (ts.isArrowFunction(node)) {
		return ts.factory.updateArrowFunction(node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, node.body) as unknown as T;
	}
	if (ts.isYieldExpression(node)) {
		return ts.factory.updateYieldExpression(node, node.asteriskToken, node.expression) as unknown as T;
	}
	if (ts.isAwaitExpression(node)) {
		return ts.factory.updateAwaitExpression(node, node.expression) as unknown as T;
	}

	// JSX ----------------------------------------------------------------------
	if (ts.isJsxElement(node)) {
		return ts.factory.updateJsxElement(node, node.openingElement, node.children, node.closingElement) as unknown as T;
	}
	if (ts.isJsxSelfClosingElement(node)) {
		return ts.factory.updateJsxSelfClosingElement(node, node.tagName, node.typeArguments, node.attributes) as unknown as T;
	}
	if (ts.isJsxOpeningElement(node)) {
		return ts.factory.updateJsxOpeningElement(node, node.tagName, node.typeArguments, node.attributes) as unknown as T;
	}
	if (ts.isJsxClosingElement(node)) {
		return ts.factory.updateJsxClosingElement(node, node.tagName) as unknown as T;
	}
	if (ts.isJsxFragment(node)) {
		return ts.factory.updateJsxFragment(node, node.openingFragment, node.children, node.closingFragment) as unknown as T;
	}
	if (ts.isJsxOpeningFragment(node)) {
		return ts.factory.createJsxOpeningFragment() as unknown as T;
	}
	if (ts.isJsxClosingElement(node)) {
		return ts.factory.updateJsxClosingElement(node, node.tagName) as unknown as T;
	}
	if (ts.isJsxAttribute(node)) {
		return ts.factory.updateJsxAttribute(node, node.name, node.initializer) as unknown as T;
	}
	if (ts.isJsxAttributes(node)) {
		return ts.factory.updateJsxAttributes(node, node.properties) as unknown as T;
	}
	if (ts.isJsxExpression(node)) {
		return ts.factory.updateJsxExpression(node, node.expression) as unknown as T;
	}

	// Types --------------------------------------------------------------------
	if (ts.isTypeReferenceNode(node)) {
		return ts.factory.updateTypeReferenceNode(node, node.typeName, node.typeArguments) as unknown as T;
	}
	if (ts.isUnionTypeNode(node)) {
		return ts.factory.updateUnionTypeNode(node, node.types) as unknown as T;
	}
	if (ts.isIntersectionTypeNode(node)) {
		return ts.factory.updateIntersectionTypeNode(node, node.types) as unknown as T;
	}
	if (ts.isArrayTypeNode(node)) {
		return ts.factory.updateArrayTypeNode(node, node.elementType) as unknown as T;
	}
	if (ts.isTupleTypeNode(node)) {
		return ts.factory.updateTupleTypeNode(node, node.elements) as unknown as T;
	}
	if (ts.isTypeLiteralNode(node)) {
		return ts.factory.updateTypeLiteralNode(node, node.members) as unknown as T;
	}
	if (ts.isFunctionTypeNode(node)) {
		return ts.factory.updateFunctionTypeNode(node, node.typeParameters, node.parameters, node.type) as unknown as T;
	}
	if (ts.isConstructorTypeNode(node)) {
		return ts.factory.updateConstructorTypeNode(node, node.modifiers, node.typeParameters, node.parameters, node.type) as unknown as T;
	}
	if (ts.isIndexedAccessTypeNode(node)) {
		return ts.factory.updateIndexedAccessTypeNode(node, node.objectType, node.indexType) as unknown as T;
	}
	if (ts.isTypeOperatorNode(node)) {
		return ts.factory.updateTypeOperatorNode(node, node.type) as unknown as T;
	}
	if (ts.isMappedTypeNode(node)) {
		return ts.factory.updateMappedTypeNode(node, node.readonlyToken, node.typeParameter, node.nameType, node.questionToken, node.type, node.members) as unknown as T;
	}
	if (ts.isConditionalTypeNode(node)) {
		return ts.factory.updateConditionalTypeNode(node, node.checkType, node.extendsType, node.trueType, node.falseType) as unknown as T;
	}
	if (ts.isTemplateLiteralTypeNode(node)) {
		return ts.factory.updateTemplateLiteralType(node, node.head, node.templateSpans) as unknown as T;
	}
	if (ts.isTypePredicateNode(node)) {
		return ts.factory.updateTypePredicateNode(node, node.assertsModifier, node.parameterName, node.type) as unknown as T;
	}
	if (ts.isInferTypeNode(node)) {
		return ts.factory.updateInferTypeNode(node, node.typeParameter) as unknown as T;
	}

	// Signatures & Parameters --------------------------------------------------
	if (ts.isTypeParameterDeclaration(node)) {
		return ts.factory.updateTypeParameterDeclaration(node, node.modifiers, node.name, node.constraint, node.default) as unknown as T;
	}
	if (ts.isParameter(node)) {
		return ts.factory.updateParameterDeclaration(node, node.modifiers, node.dotDotDotToken, node.name, node.questionToken, node.type, node.initializer) as unknown as T;
	}

	// Imports/Exports & Misc ---------------------------------------------------
	if (ts.isDecorator(node)) {
		return ts.factory.updateDecorator(node, node.expression) as unknown as T;
	}
	if (ts.isModifier(node)) {
		// Modifiers are tokens; factory has create but not update for tokens—return as is.
		return node;
	}
	if (ts.isComputedPropertyName(node)) {
		return ts.factory.updateComputedPropertyName(node, node.expression) as unknown as T;
	}
	if (ts.isIndexSignatureDeclaration(node)) {
		return ts.factory.updateIndexSignature(node, node.modifiers, node.parameters, node.type) as unknown as T;
	}
	if (ts.isCallSignatureDeclaration(node)) {
		return ts.factory.updateCallSignature(node, node.typeParameters, node.parameters, node.type) as unknown as T;
	}
	if (ts.isConstructSignatureDeclaration(node)) {
		return ts.factory.updateConstructSignature(node, node.typeParameters, node.parameters, node.type) as unknown as T;
	}

	// Fallback: no update function handled; return original node.
	return node;
}

/**
 * Replaces the JSDoc of a declaration node with the given text.
 * @param node The declaration node (FunctionDeclaration, MethodDeclaration, ClassDeclaration, etc.)
 * @param jsDocLines The JSDoc lines WITHOUT the start; this function wraps them properly.
 */
export function replaceJsDoc<T extends ts.HasJSDoc>(node: T, jsDocLines: JSDocLike[], singleLine: boolean = jsDocLines.length == 1): T {
	// Clone/update the node first (to avoid carrying source trivia that the printer would reuse)
	// If your node kind has a factory.update function, use it; otherwise you may need to recreate.
	let updated = updateNode(node);

	// Suppress any original leading comments for this node during emit.
	ts.setEmitFlags(updated, ts.EmitFlags.NoLeadingComments);

	// Clear any synthetic leading comments that might already be present.
	ts.setSyntheticLeadingComments(updated, []);

	if (jsDocLines.length > 0) {
		ts.addSyntheticLeadingComment(updated, ts.SyntaxKind.MultiLineCommentTrivia, makeJsDocText(jsDocLines.map(printJSDocLike)), /* hasTrailingNewLine */ true);
	}
	return updated;
}

export function addJSDocs<T extends ts.HasJSDoc>(node: T, _docs: JSDocLike | JSDocLike[], hasTrailingNewLine: boolean = !(typeof _docs == "string")) {
	var doc: string;
	if (Array.isArray(_docs)) {
		if (_docs.length == 0) {
			return ts.setSyntheticLeadingComments(node, []);
		}
		doc = ["*", ..._docs.flatMap(printJSDocLike).map((d) => ` * ${d}`), ""].join("\n");
	} else {
		doc = `* ${printJSDocLike(_docs).trim()} `;
	}
	try {
		return ts.addSyntheticLeadingComment(node, ts.SyntaxKind.MultiLineCommentTrivia, doc, ts.isParameter(node) && !Array.isArray(_docs) ? false : hasTrailingNewLine);
	} catch (ex) {
		console.error(ex);
		return node;
	}
}

export function groupBy<T, K extends string | number>(items: Iterable<T>, getGroup: (item: T) => K): { [P in K as `${P}`]: T[] } {
	return [...items].reduce<{ [P in K as `${P}`]: T[] }>(
		(state, curr) => {
			var group = `${getGroup(curr)}`;
			if (!(group in state))
				// @ts-ignore
				state[group] = [];
			// @ts-ignore
			state[group].push(curr);
			return state;
		},
		{} as { [P in K as `${P}`]: T[] },
	);
}

/** Apply a single file's text changes to a string. */
export function applyTextChangesToString(original: string, changes: readonly ts.TextChange[]): string {
	// Sort by descending start so earlier replacements don't affect later indices.
	const sorted = [...changes].sort((a, b) => b.span.start - a.span.start);

	// Optional: sanity-check for overlapping changes
	for (let i = 0; i < sorted.length - 1; i++) {
		const cur = sorted[i];
		const next = sorted[i + 1];
		const curStart = cur.span.start;
		const curEnd = cur.span.start + cur.span.length;
		const nextStart = next.span.start;
		const nextEnd = next.span.start + next.span.length;
		const overlap = !(curEnd <= nextStart || nextEnd <= curStart);
		if (overlap) {
			throw new Error(`Overlapping changes detected at spans (${curStart}, ${curEnd}) and (${nextStart}, ${nextEnd}).`);
		}
	}

	// Apply from right to left
	let text = original;
	for (const change of sorted) {
		const { start, length } = change.span;
		text = text.slice(0, start) + change.newText + text.slice(start + length);
	}
	return text;
}

/** Apply a set of FileTextChanges to the filesystem (or to in-memory strings). */
export function applyFileTextChanges(
	system: {
		readFile: (fileName: string) => string | undefined;
		writeFile?: (fileName: string, content: string) => void;
	},
	allChanges: readonly ts.FileTextChanges[],
) {
	return Object.entries(
		groupBy(allChanges, (change) =>
			stableStringify({
				fileName: change.fileName,
				isNewFile: !!change.isNewFile,
			}),
		),
	)
		.map((e) => {
			var file: { fileName: string; isNewFile: boolean } = JSON.parse(`${e[0]}`);
			const currentText = file.isNewFile ? "" : (system.readFile(file.fileName) ?? "");
			const updated = applyTextChangesToString(
				currentText,
				e[1].flatMap((f) => f.textChanges),
			);
			if (system.writeFile) {
				system.writeFile(file.fileName, updated);
				return file.fileName;
			}
		})
		.filter(isNotEmpty);
}

export function applyFileChanges(fileMap: Map<string, string>, allChanges: readonly ts.FileTextChanges[]) {
	Object.entries(groupBy(allChanges, (change) => change.fileName)).map((e) => {
		var fileName = e[0];
		const currentText = fileMap.get(fileName) || "";
		const updated = applyTextChangesToString(
			currentText,
			e[1].flatMap((f) => f.textChanges),
		);
		fileMap.set(fileName, updated);
	});

	return fileMap;
}

export function getAllDiagnostics(program: ts.Program, sourceFile: ts.SourceFile, cancellationToken?: ts.CancellationToken) {
	return ts.sortAndDeduplicateDiagnostics([
		...program.getSemanticDiagnostics(sourceFile, cancellationToken),
		...program.getSuggestionDiagnostics(sourceFile, cancellationToken),
		...program.getSyntacticDiagnostics(sourceFile, cancellationToken),
	]);
}

export function isDiagnosticWithLocation(diag: ts.Diagnostic): diag is ts.DiagnosticWithLocation {
	return !!diag.file && typeof diag.start != "undefined" && typeof diag.length != "undefined";
}

export function registerCodeFix(
	key: string,
	errorCodes: readonly number[],
	message: string = key,
	category: ts.DiagnosticCategory = ts.DiagnosticCategory.Error,
	makeChanges: (context: ts.CodeFixContext, changeTracker: ts.textChanges.ChangeTracker, diags: readonly ts.DiagnosticWithLocation[], fixedNodes: Set<ts.Node>) => void,
	refreshAfterFix?: boolean,
	command?: ts.InstallPackageAction,
) {
	const description = {
		key,
		code: errorCodes[0],
		message,
		category,
	};

	const fixId = description.key;
	//const errorCodes = [description.code];

	var fix: ts.CodeFixRegistration = {
		errorCodes,
		fixIds: [fixId],
		getCodeActions: (context) => {
			var diags = ts.getDiagnosticsWithinSpan(context.span, getAllDiagnostics(context.program, context.sourceFile, context.cancellationToken));
			const changes = ts.textChanges.ChangeTracker.with(context, (t) => makeChanges(context, t, diags, new Set<ts.Node>()));
			if (changes.length > 0) {
				return [ts.codefix.createCodeFixAction(fixId, changes, description, fixId, description, command)];
			}
			return undefined;
		},
		getAllCodeActions:
			refreshAfterFix ? undefined : (
				(context) => {
					var fixedNodes = new Set<ts.Node>();
					try {
						return ts.codefix.codeFixAll(context, [...errorCodes], (changes, diag) =>
							makeChanges(
								{
									...context,
									sourceFile: diag.file,
									errorCode: diag.code,
									span: {
										start: diag.start,
										length: diag.length,
									},
								},
								changes,
								[diag],
								fixedNodes,
							),
						);
					} catch (ex) {
						fixedNodes = new Set<ts.Node>();
						var changes = getAllDiagnostics(context.program, context.sourceFile, context.cancellationToken)
							.filter(isDiagnosticWithLocation)
							.flatMap((diag) => {
								try {
									return ts.textChanges.ChangeTracker.with(context, (t) =>
										makeChanges(
											{
												...context,
												sourceFile: diag.file,
												errorCode: diag.code,
												span: {
													start: diag.start,
													length: diag.length,
												},
											},
											t,
											[diag],
											fixedNodes,
										),
									);
								} catch (ex) {
									return [];
								}
							});
						return { changes };
					}
				}
			),
	};
	try {
		ts.codefix.registerCodeFix(fix);
		console.info(`Code fix "${fix.fixIds}": ${fix.errorCodes} registered`);
	} catch (ex) {
		console.error(`Error registering fix "${fix.fixIds}": ${fix.errorCodes}: ${ex}`);
	}
	return fix;
}

export function findNodeOfType<T extends ts.Node>(sourceFile: ts.SourceFile, start: number, predicate: (node: ts.Node) => node is T): T | undefined {
	var token = ts.getTokenAtPosition(sourceFile, start);
	if (predicate(token)) return token;
	return ts.findAncestor(token, predicate);
}
export function transpileCode(transformCode: string, transpileOptions: ts.TranspileOptions = {}) {
	const result = ts.transpileModule(transformCode, {
		...transpileOptions,
		compilerOptions: {
			...transpileOptions.compilerOptions,
			module: ts.ModuleKind.CommonJS, // <-- important
		},
		reportDiagnostics: true,
	});

	var error = result.diagnostics?.find((d) => d.category == ts.DiagnosticCategory.Error);
	if (error) {
		throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"), { cause: error });
	}

	return result.outputText;
}

export function emitSourceText(sourceText: string) {
	var project = new Project({
		useInMemoryFileSystem: true,
	});
	return project.createSourceFile("index.js", sourceText).getEmitOutput({ emitOnlyDtsFiles: false }).getOutputFiles().find(isNotEmpty)?.getText() || sourceText;
}

export function exprReviver(key: any, value: any): ts.Expression {
	if (value == null) {
		return ts.factory.createNull();
	}

	try {
		switch (typeof value) {
			case "boolean":
				return value ? ts.factory.createTrue() : ts.factory.createFalse();
			case "number":
				return value < 0 ?
						ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createNumericLiteral(value * -1))
					:	ts.factory.createNumericLiteral(value);
			case "undefined":
				return ts.factory.createIdentifier("undefined");
			case "function":
				var sf = ts.createSourceFile("generated.js", value + "", ts.ScriptTarget.Latest, undefined);
				return sf.statements.length > 0 && ts.isExpressionStatement(sf.statements[0]) ?
						sf.statements[0].expression
					:	ts.factory.createNoSubstitutionTemplateLiteral(value + "");
			case "object":
				if (ts.isExpression(value as any)) return value as unknown as ts.Expression;
				if (Array.isArray(value)) {
					return ts.factory.createArrayLiteralExpression(
						value.map((v, i, arr) => exprReviver.call(arr, i, v)),
						true,
					);
				}
				return ts.factory.createObjectLiteralExpression(
					Object.keys(value)
						.sort()
						.map((key) => [key, value[key]])
						.map((e) => ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(e[0]), exprReviver.call(value, e[0], e[1]))),
					true,
				);
			case "string":
				if (value.trim() == "") return ts.factory.createNull();

				/* try {
				var ret = JSON.parse(value, exprReviver);
					return ret;
				} catch (ex) {
				}
 */
				/*try {
						var host = createInMemoryCompilerHost();
						host.setFile("generated.js", value);
						var program = host.createProgram();
						let sf = program.getSourceFile("generated.js");
	
						//let sf = ts.createSourceFile("generated.js", value, ts.ScriptTarget.Latest, undefined, ts.ScriptKind.JS);
						if (sf) {
							var diags = program.getSyntacticDiagnostics(sf);
							if (diags.length == 0) {
								var expr = sf.statements.length > 0 && ts.isExpressionStatement(sf.statements[0]) ? sf.statements[0].expression : undefined;
								if (expr && !ts.isLiteralExpression(expr) && !ts.isIdentifier(expr)) {
									var factory = ts.factory;
									return factory.createArrowFunction(
										undefined,
										undefined,
										[factory.createParameterDeclaration(
											undefined,
											undefined,
											factory.createObjectBindingPattern([]),
											undefined,
											undefined,
											undefined
										)],
										undefined,
										factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
										factory.createCallExpression(
											factory.createParenthesizedExpression(factory.createFunctionExpression(
												undefined,
												undefined,
												undefined,
												undefined,
												[],
												undefined,
												factory.createBlock(
													sf.statements,
													true
												)
											)),
											undefined,
											[]
										)
									);
								}
							}
						}
					} catch (ex) {
					}*/

				return ts.factory.createNoSubstitutionTemplateLiteral(value);
			default:
				break;
		}
	} catch (ex) {
		console.error(`error exprReviver on "${key}": ${typeof value}: ${ex}`);
	}
	return ts.factory.createIdentifier("undefined");
}

export function printSourceText(value: any) {
	if (isEmpty(value)) return "null";
	var sf: ts.SourceFile;
	//if (typeof value == "object") {
	sf = ts.factory.createSourceFile(
		[ts.factory.createExpressionStatement(exprReviver(null, value))],
		ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
		ts.NodeFlags.JavaScriptFile,
	);

	//} else {
	//sf = ts.createSourceFile("generated.js", value + "", ts.ScriptTarget.Latest, true)
	//	}
	//var ;
	var ret = ts
		.createPrinter()
		.printFile(sf)
		.replace(/\s*;\s*$/, "")
		.trim();
	return ret;
}

export function getFlagNames<T extends object>(value: number, Flags: T, ...excludeVals: T[keyof T][]): Extract<keyof T, string>[] {
	//var v = Flags[value];
	return (Object.keys(Flags) as Extract<keyof T, string>[])
		.filter((flag) => !excludeVals.includes(Flags[flag]))
		.filter((flag) => hasFlags(value, Flags[flag] as number))
		.sort();
}

export function getFlagName<T extends object>(value: number, Flags: T, ...excludeVals: T[keyof T][]): Extract<keyof T, string> | undefined {
	//var v = Flags[value];
	return (Object.keys(Flags) as Extract<keyof T, string>[])
		.filter((flag) => !excludeVals.includes(Flags[flag]))
		.filter((flag) => Flags[flag] == value)
		.find(isNotEmpty);
}

export function stableStringify(x: any): string {
	if (x == null || typeof x !== "object") return JSON.stringify(x);
	if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
	const keys = Object.keys(x).sort();
	return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(x[k])).join(",")}}`;
}

/**
 * Converts TypeScript CommentRanges into SyntheticComments
 */
export function commentRangeToSynthetic(sourceText: string, range: ts.CommentRange) {
	const fullText = sourceText.slice(range.pos, range.end);
	// Remove comment delimiters
	const text = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? fullText.replace(/^\/\//, "") : fullText.replace(/^\/\*|\*\/$/g, "");

	var ret: ts.SynthesizedComment = {
		kind: range.kind,
		text,
		hasTrailingNewLine: Boolean(range.hasTrailingNewLine),
		pos: -1,
		end: -1,
		hasLeadingNewline: fullText.startsWith("\n"),
	};
	//console.log(ret);
	return ret;
}

export function moveComments<T extends ts.Node>(newNode: T, originalNode?: ts.Node): T {
	try {
		var thisNode = originalNode ?? newNode;
		const text = thisNode.getFullText();

		(ts.getLeadingCommentRanges(text, 0) || [])
			.map((range) => commentRangeToSynthetic(text, range))
			.forEach((range) => ts.addSyntheticLeadingComment(thisNode, range.kind, range.text, range.hasTrailingNewLine));

		(ts.getTrailingCommentRanges(text, thisNode.end - thisNode.pos) || [])
			.map((range) => commentRangeToSynthetic(text, range))
			.forEach((range) => ts.addSyntheticTrailingComment(thisNode, range.kind, range.text, range.hasTrailingNewLine));
	} catch (ex) {}

	try {
		if (originalNode) return ts.moveSyntheticComments(newNode, originalNode);
		//ts.setSyntheticLeadingComments(newNode, ts.getSyntheticLeadingComments(originalNode));
		//ts.setSyntheticTrailingComments(newNode, ts.getSyntheticTrailingComments(originalNode));
	} catch (ex) {}
	return newNode;
}

export function isAmbientContext(node: ts.Node): boolean {
	let current: ts.Node | undefined = node.parent;
	while (current) {
		if (ts.canHaveModifiers(current) && !!ts.getModifiers(current)?.find((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
			return true;
		}

		current = current.parent;
	}

	return false;
}

export function sortMembers<T extends ts.NamedDeclaration>(members: T[]): T[] {
	return members.sort((a, b) => {
		return a.kind == b.kind ? printNode(a.name).localeCompare(printNode(b.name)) : b.kind - a.kind;
	});
}
