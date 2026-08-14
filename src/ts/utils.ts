import { printNode } from "ts-morph";
import ts from "typescript";

type JSDocLike = string | ts.JSDocComment | ts.JSDocTag;

export type TSAssignmentNode = ts.BinaryExpression | ts.PropertyAssignment | ts.ShorthandPropertyAssignment | ts.SpreadAssignment | ts.VariableDeclaration | ts.AssignmentExpression<ts.EqualsToken>;

export function isNotEmpty<T>(arg: T | null | undefined): arg is T {
	if (arg == null || typeof arg == "undefined")
		return false;
	if (typeof arg == "string") {
		return arg.trim() != "" && arg.trim().toLowerCase() != "undefined" && arg.trim().toLowerCase() != "null";
	}
	return true;
}

export function isEmpty(arg: any): arg is null | undefined {
	return !isNotEmpty(arg);
}

export function TSgetInitializer(node: TSAssignmentNode | undefined) {
	if (!node)
		return undefined;
	if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node))
		return node.initializer;
	if (ts.isAssignmentExpression(node) || ts.isBinaryExpression(node))
		return node.right;
	if (ts.isSpreadAssignment(node))
		return node.expression;
	if (ts.isShorthandPropertyAssignment(node))
		return node.objectAssignmentInitializer;
	return undefined;
}

export const validProperty = /^[A-Za-z_$][A-Za-z0-9_$]*$/ ///^(?![0-9])[a-zA-Z0-9$_]+$/;

export type IdentifierString = (string & ts.Identifier["escapedText"]) | string;

export function isValidIdentifier(str: any): str is IdentifierString {
	if (isEmpty(str))
		return false;
	return `${str}`.split(".").every(a => validProperty.test(a));
}

export function getModifiers(modifiers?: ts.NodeArray<ts.ModifierLike>): ts.Modifier[] | undefined {
	if (!modifiers)
		return undefined;
	return modifiers.map(m => {
		if (ts.isModifier(m))
			return m;
		return undefined;
	}).filter(a => !!a);
}


function isNode(value: any): value is ts.Node {
	return !!value && (value.constructor.name == "NodeObject" || ts.isSourceFile(value));
	return !!value && typeof value.kind === "number" && typeof value.pos === "number" && typeof value.end === "number";
}


export function createStringConcat(left: ts.Expression | string, right: ts.Expression | ts.Expression[]) {
	return ts.factory.createCallExpression(
		ts.factory.createPropertyAccessExpression(
			typeof left == "string" ? ts.factory.createStringLiteral(left) : left,
			"concat"
		),
		undefined,
		Array.isArray(right) ? right : [right]
	)
}

/**
 * Checks if a node's type is assignable to string.
 * Handles union and intersection types.
 * @param node - The AST node to check.
 * @param checker - The TypeScript TypeChecker instance.
 * @param strict - If true, all members (union or intersection) must be assignable to string.
 *                 If false, at least one member must be assignable.
 */
export function isNodeAssignableToString(
	node: ts.Node,
	checker: ts.TypeChecker,
	strict: boolean = false
) {
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
			return strict
				? nodeType.types.every(checkType)
				: nodeType.types.some(checkType);
		}

		// Handle Intersection Types
		if (nodeType.isIntersection()) {
			return strict
				? nodeType.types.every(checkType)
				: nodeType.types.some(checkType);
		}

		// Handle normal types
		return checkType(nodeType);
	})();
	if (!ret)
		console.warn(`isNodeAssignableToString: ${printNode(node)}: ${checker.typeToString(nodeType)}: ${ret}`);
	return ret;
}

export function TSgetIdentifier(node: TSAssignmentNode | undefined) {
	if (!node)
		return undefined;
	if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
		return node.name;
	if (ts.isAssignmentExpression(node) || ts.isBinaryExpression(node))
		return node.left
	if (ts.isSpreadAssignment(node))
		return node.name;
	return undefined;
}

export function isAsConstExpression(node: ts.Node | undefined) {
	return !!ts.findAncestor(node, (node) => {
		if (!node || ts.isStatement(node))
			return false;

		if (ts.isParenthesizedExpression(node)) {
			if (ts.canHaveJSDoc(node.expression)) {
				if (ts.getJSDocTags(node.expression)
					.some(tag => ts.isJSDocTypeTag(tag) && ts.isConstTypeReference(tag.typeExpression.type)))
					return true;
			}
		}

		return ts.isAsExpression(node) && ts.isConstTypeReference(node.type);
	});
}

export function TSisAssignment(node: ts.Node | undefined): node is ts.BinaryExpression | ts.PropertyAssignment | ts.ShorthandPropertyAssignment | ts.SpreadAssignment | ts.VariableDeclaration | ts.AssignmentExpression<ts.EqualsToken> {
	if (!node)
		return false;
	return ts.isSpreadAssignment(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || (ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent)) || ts.isAssignmentExpression(node, false) || (ts.isBinaryExpression(node) && node.operatorToken.kind == ts.SyntaxKind.EqualsToken);
}

export function printJSDocLike(doc: JSDocLike) {
	if (typeof doc == "string")
		return doc;
	var sf = ts.factory.createSourceFile(
		[
			doc as any
		],
		ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
		ts.NodeFlags.JSDoc
	);
	return ts.createPrinter({ removeComments: false }).printFile(sf);
}

export function addJSDocs<T extends ts.HasJSDoc>(node: T, _docs: JSDocLike | JSDocLike[], hasTrailingNewLine: boolean = !(typeof _docs == "string")) {
	var doc: string;
	if (Array.isArray(_docs)) {
		doc = [
			"*",
			..._docs.flatMap(printJSDocLike).map(d => d.split("\n")).map(d => ` * ${d}`),
			""
		]
			.join("\n")
	} else {
		doc = `* ${printJSDocLike(_docs).trim()} `;
	}
	try {
		return ts.addSyntheticLeadingComment(
			node,
			ts.SyntaxKind.MultiLineCommentTrivia,
			doc,
			ts.isParameter(node) && !Array.isArray(_docs) ? false : hasTrailingNewLine
		)
	} catch (ex) {
		console.error(ex);
		return node;
	}
}

export function groupBy<T, K extends string | number>(items: Iterable<T>, getGroup: (item: T) => K): { [P in K as `${P}`]: T[] } {
	return [...items].reduce<{ [P in K as `${P}`]: T[] }>((state, curr) => {
		var group = `${getGroup(curr)}`;
		if (!(group in state))
			// @ts-ignore
			state[group] = [];
		// @ts-ignore
		state[group].push(curr);
		return state;
	}, {} as { [P in K as `${P}`]: T[] })
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
	allChanges: readonly ts.FileTextChanges[]
) {
	Object.entries(groupBy(allChanges, change => JSON.stringify({
		fileName: change.fileName,
		isNewFile: !!change.isNewFile
	})))
		.forEach(e => {
			var file = JSON.parse(`${e[0]}`);
			const currentText = file.isNewFile ? "" : system.readFile(file.fileName) ?? "";
			const updated = applyTextChangesToString(currentText, e[1].flatMap(f => f.textChanges));
			if (system.writeFile) {
				system.writeFile(file.fileName, updated);
			}
		})
}

export function getAllDiagnostics(program: ts.Program, sourceFile: ts.SourceFile, cancellationToken?: ts.CancellationToken) {
	return ts.sortAndDeduplicateDiagnostics([
		...program.getSemanticDiagnostics(sourceFile, cancellationToken),
		...program.getSuggestionDiagnostics(sourceFile, cancellationToken),
		...program.getSyntacticDiagnostics(sourceFile, cancellationToken)
	])
}

export function isDiagnosticWithLocation(diag: ts.Diagnostic): diag is ts.DiagnosticWithLocation {
	return !!diag.file && typeof diag.start != "undefined" && typeof diag.length != "undefined";
}

export function registerCodeFix(key: string, errorCodes: readonly number[], message: string = key, category: ts.DiagnosticCategory = ts.DiagnosticCategory.Error, makeChanges: (context: ts.CodeFixContext, changeTracker: ts.textChanges.ChangeTracker, diags: readonly ts.DiagnosticWithLocation[], fixedNodes: Set<ts.Node>) => void, refreshAfterFix?: boolean, command?: ts.InstallPackageAction) {
	const description = {
		key,
		code: errorCodes[0],
		message,
		category
	};

	const fixId = description.key;
	//const errorCodes = [description.code];	

	var fix: ts.CodeFixRegistration = ({
		errorCodes,
		fixIds: [fixId],
		getCodeActions: (context) => {
			var diags = ts.getDiagnosticsWithinSpan(context.span, getAllDiagnostics(context.program, context.sourceFile, context.cancellationToken))
			const changes = ts.textChanges.ChangeTracker.with(context, t => makeChanges(context, t, diags, new Set<ts.Node>()));
			if (changes.length > 0) {
				return [ts.codefix.createCodeFixAction(fixId, changes, description, fixId, description, command)];
			}
			return undefined;
		},
		getAllCodeActions: refreshAfterFix ? undefined : (context) => {
			var fixedNodes = new Set<ts.Node>();
			try {
				return ts.codefix.codeFixAll(context, [...errorCodes], (changes, diag) => makeChanges({
					...context,
					sourceFile: diag.file,
					errorCode: diag.code,
					span: {
						start: diag.start,
						length: diag.length
					}
				}, changes, [diag], fixedNodes));
			} catch (ex) {
				fixedNodes = new Set<ts.Node>();
				var changes = getAllDiagnostics(context.program, context.sourceFile, context.cancellationToken)
					.filter(isDiagnosticWithLocation)
					.flatMap(diag => {
						try {
							return ts.textChanges.ChangeTracker.with(context, t => makeChanges({
								...context,
								sourceFile: diag.file,
								errorCode: diag.code,
								span: {
									start: diag.start,
									length: diag.length

								}
							}, t, [diag], fixedNodes));

						} catch (ex) {
							return []
						}
					});
				return { changes };
			};
		}
	});
	try {
		ts.codefix.registerCodeFix(fix);
		console.info(`Code fix "${fix.fixIds}": ${fix.errorCodes} registered`);
	}
	catch (ex) {
		console.error(`Error registering fix "${fix.fixIds}": ${fix.errorCodes}: ${ex}`);
	}
	return fix;
}

export function findNodeOfType<T extends ts.Node>(sourceFile: ts.SourceFile, start: number, predicate: (node: ts.Node) => node is T): T | undefined {
	var token = ts.getTokenAtPosition(sourceFile, start);
	if (predicate(token))
		return token;
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
	})

	var error = result.diagnostics?.find(d => d.category == ts.DiagnosticCategory.Error);
	if (error) {
		throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'), { cause: error })
	}

	return result.outputText;
}