import {
	Node,
	createWrappedNode,
	printNode,
	SourceFile,
	SourceFileCreateOptions,
	SpreadAssignment,
	PropertyAssignment,
	ShorthandPropertyAssignment,
	VariableDeclaration,
	BinaryExpression,
	AssignmentExpression,
	Type,
	ts,
	FormatCodeSettings,
	UserPreferences,
	FileTextChanges,
	Project,
	StructureKind,
	ModuleDeclarationKind,
} from "ts-morph";
import { IdentifierString, isEmpty, isNotEmpty, isValidIdentifier, printSourceText } from "../ts/utils";

import _path from "path";
import createConsts from "../../storage/transformers/createConsts";

type NodeVisitor<TIn extends ts.Node = ts.Node, TOut extends ts.Node | undefined = TIn | undefined> = (
	node: TIn,
	visitor: ts.Visitor<TIn, TOut>,
	context?: ts.TransformationContext,
	program?: ts.Program,
) => ts.VisitResult<TOut>;

/**
 * Wraps a {@link NodeVisitor} function into a `ts.TransformerFactory` that
 * visits every descendant of the root node, safely catches visitor errors, and
 * returns the original node on failure.
 *
 * @param visitorFn - The visitor to apply to each node.
 * @param program - Optional TypeScript program forwarded to the visitor.
 * @returns A `ts.TransformerFactory` wrapping the visitor.
 */
export function visitNodes<TIn extends ts.Node = ts.Node, TOut extends ts.Node | undefined = TIn | undefined>(
	visitorFn: NodeVisitor<TIn, TOut>,
	program?: ts.Program,
): ts.TransformerFactory<TIn> {
	return (context: ts.TransformationContext) => {
		return (sourceFile: TIn) => {
			var __visitor = (node: any) => {
				try {
					return node && visitorFn(node, __visitor, context, program);
				} catch (ex) {
					return node;
				}
			};
			return ts.visitEachChild(sourceFile, __visitor, context);
		};
	};
}

/**
 * Transforms the given TypeScript AST nodes using the provided visitors.
 *
 * @template T - The type of the AST nodes to transform, extending `ts.Node`.
 * @param source - The source AST node or nodes to transform.
 * @param visitors - An array of node visitors to apply during the transformation.
 * @param compilerOptions - Optional compiler options to use during the transformation.
 * @returns The result of the transformation, including the transformed nodes.
 */
export function transformScript<T extends ts.Node = ts.Node>(
	source: T | T[],
	visitors: NodeVisitor<T>[],
	program?: ts.Program,
	compilerOptions: ts.CompilerOptions | undefined = program?.getCompilerOptions(),
) {
	return ts.transform<T>(
		source,
		visitors.map((v) => visitNodes(v, program)),
		compilerOptions,
	);
}

/**
 * Applies a list of `ts.TransformerFactory` transforms to a ts-morph
 * `SourceFile` and returns the updated file from the project.
 *
 * The transformed output is written back via `project.createSourceFile` with
 * `overwrite: true`.
 *
 * @param sourceFile - The ts-morph source file to transform.
 * @param transforms - Compiler-API transformer factories to apply.
 * @returns The updated `SourceFile`, or the original if the path was not found
 *   in the transform result.
 */
export function transformSourceFile(sourceFile: SourceFile, transforms: ts.TransformerFactory<ts.SourceFile>[]) {
	var project = sourceFile.getProject();
	var program = project.getProgram().compilerObject;
	return (
		ts
			.transform(sourceFile.compilerNode, transforms, project.getCompilerOptions())
			.transformed.map((sf) => {
				return project.createSourceFile(sf.fileName, printNode(sf, sf), {
					overwrite: true,
				});
			})
			.find((sf) => sf.getFilePath() == sourceFile.getFilePath()) || sourceFile
	);
}

/**
 * Applies the `createConsts` transformer to the given source file, converting
 * `var`/`let` declarations to `const` where safe.
 *
 * @param sf - The ts-morph `SourceFile` to transform.
 * @returns The updated `SourceFile`.
 */
export function createConst(sf: SourceFile) {
	return transformSourceFile(sf, [createConsts({ program: sf.getProject().getProgram().compilerObject })]);
}

/**
 * Returns `true` when `node` resides in a JavaScript (`.js`) file.
 *
 * @param node - Any ts-morph `Node`.
 */
export function isJavascrpt(node: Node) {
	return ts.isInJSFile(node.compilerNode);
}

function renameSourceFile(sourceFile: SourceFile, newPath: string, options?: SourceFileCreateOptions) {
	var project = sourceFile.getProject();
	if (_path.normalize(sourceFile.getFilePath()) == _path.normalize(newPath)) return sourceFile;
	var newSf = project.createSourceFile(newPath, sourceFile.getStructure(), options);
	sourceFile.deleteImmediatelySync();
	return newSf;
}

/**
 * Walks up the ancestor chain from `node` to find the nearest JSDoc-able
 * ancestor (or returns `node` itself if it is already JSDoc-able).
 *
 * @param node - The starting node.
 * @returns The nearest JSDoc-able node, or `undefined` if none exists.
 */
export function getJSDocs(node: Node) {
	if (!node) return undefined;
	if (Node.isJSDocable(node)) {
		return node;
	}
	return node.getFirstAncestor(Node.isJSDocable);
}

/**
 * Type guard that returns `true` when `node` exposes a `remove()` method.
 *
 * @param node - Any ts-morph node, or `undefined`.
 * @returns `true` if `node` is defined and has a callable `remove` method.
 */
export function isRemoveable<T extends Node>(
	node?: T,
): node is T & {
	remove(): void;
} {
	return !!node && "remove" in node && typeof node.remove == "function";
}

export type AssignmentNode =
	| SpreadAssignment
	| PropertyAssignment
	| ShorthandPropertyAssignment
	| VariableDeclaration
	| BinaryExpression
	| AssignmentExpression<ts.AssignmentExpression<ts.EqualsToken>>;

/**
 * Type guard: returns `true` when `node` is a ts-morph assignment expression
 * (binary `=` assignment).
 *
 * @param node - Any ts-morph node, or `undefined`.
 */
export function isAssignmentExpression(node?: Node): node is AssignmentExpression<ts.AssignmentExpression<ts.EqualsToken>> {
	return !!node && ts.isAssignmentExpression(node.compilerNode, true);
}

/**
 * Type guard that returns `true` when `node` is any of the ts-morph
 * {@link AssignmentNode} variants (spread, property, shorthand property,
 * variable declaration, assignment expression, or binary `=`).
 *
 * @param node - Any ts-morph node, or `undefined`.
 */
export function isAssignment(node: Node | undefined): node is AssignmentNode {
	return (
		Node.isSpreadAssignment(node) ||
		Node.isPropertyAssignment(node) ||
		Node.isShorthandPropertyAssignment(node) ||
		Node.isVariableDeclaration(node) ||
		isAssignmentExpression(node) ||
		(Node.isBinaryExpression(node) && node.getOperatorToken().getKind() == ts.SyntaxKind.EqualsToken)
	);
}

export function isNameable<T extends Node<TS>, TS extends ts.Node>(node?: T) {
	return Node.isNode(node) && Node.hasName(node);
}

export function hasNameNode(node: any): node is Node & { getNameNode(): Node } {
	return Node.isNode(node) && !!(node as any).getNameNode && (node as any).getNameNode instanceof Function;
}

/**
 * Compares two ts-morph nodes for equality by source-file path, kind, and
 * source range (start/end positions).
 *
 * Source files are compared by file path only.
 *
 * @param node1 - The reference node.
 * @param node2 - The node to compare against.
 * @returns `true` when both nodes occupy the same position in the same file.
 */
export function nodeEquals<T extends Node>(node1: T, node2?: any): node2 is T {
	if (!Node.isNode(node2)) return false;
	if (node1.wasForgotten() || node2.wasForgotten()) return false;
	if (Node.isSourceFile(node1) && Node.isSourceFile(node2)) return node1.getFilePath().localeCompare(node2.getFilePath()) == 0;
	return (
		nodeEquals(node1.getSourceFile(), node2.getSourceFile()) && node1.getKind() == node2.getKind() && node1.getStart() == node2.getStart() && node1.getEnd() == node2.getEnd()
	);
}

/**
 * Attempts to derive the fully-qualified name of a ts-morph node by walking
 * its symbol, parent expressions, and qualified-name chains.
 *
 * @param node - The node whose name to resolve, or `undefined`.
 * @param appendDot - When `true`, appends a `.` separator if a name is found
 *   (useful for building dotted paths recursively).
 * @returns The fully-qualified name string, or an empty string if it cannot
 *   be determined.
 */
export function getFullyQualifiedName<T extends Node>(node?: T, appendDot?: boolean): string {
	if (!node) return "";
	try {
		var useBraces = false;
		if (Node.isSourceFile(node) || Node.isNewExpression(node)) return "";
		if (Node.isExpressionWithTypeArguments(node)) return getFullyQualifiedName(node.getExpression(), appendDot) || "";
		var name: IdentifierString | undefined = "";
		if (Node.isLeftHandSideExpressioned(node)) name = `${getFullyQualifiedName(node.getExpression(), Node.hasName(node)) || ""}${Node.hasName(node) ? node.getName() : ""}`;
		else if (Node.isPropertySignature(node) && !isValidIdentifier(node.getName())) {
			name = `${getFullyQualifiedName(node.getParent())}[${node.getName()}]`;
		} else
			try {
				var sym = node.getSymbol();
				name = sym?.getFullyQualifiedName();
			} catch (ex) {}
		if (isEmpty(name)) {
			if (Node.isTypeQuery(node)) {
				return `${node.getExprName().getText()}`;
			} else if (Node.isIdentifier(node)) {
				name = node.getText();
				//	name = parentSym?.getFullyQualifiedName(appendDot) || (appendDot && isNotEmpty(name) ? `${name}.` : "");
				//return name;
			}
			var parentSym = node.getParent();
			if (Node.isLiteralExpression(node)) {
				name = node.getLiteralText();
				if (isNotEmpty(name) && !isValidIdentifier(name)) {
					var parentName = getFullyQualifiedName(parentSym, false) || "";
					return (
						isNotEmpty(parentName) ? `${parentName}["${name}"]${appendDot ? "." : ""}`
						: appendDot ? `["${name}"].`
						: `"${name}"`
					);
				}
				return `${getFullyQualifiedName(parentSym, true) || ""}${appendDot && isNotEmpty(name) ? `${name}.` : name}`;
			}
			if (Node.isLeftHandSideExpressioned(parentSym) && hasNameNode(parentSym))
				return nodeEquals(node, parentSym.getNameNode()) ? getFullyQualifiedName(parentSym, appendDot) : "";
			else if (isAssignment(parentSym) || Node.isTypeQuery(parentSym) || Node.isHeritageClause(parentSym) || Node.isExpressionWithTypeArguments(parentSym))
				parentSym = undefined;
			else if (!appendDot && (Node.isQualifiedName(parentSym) || Node.isPropertyAccessExpression(parentSym))) {
				name = parentSym.getText();
			} else {
				if (Node.isIdentifier(node) || Node.isQualifiedName(node) || Node.isPropertyAccessExpression(node)) {
					return `${getFullyQualifiedName(parentSym, true) || ""}${node.getText()}`;
				}
				if (isNameable(node)) {
					return `${getFullyQualifiedName(parentSym, true) || ""}${node.getName()}`;
				}
			}

			//return parentSym?.getFullyQualifiedName();
		}
		return appendDot && isNotEmpty(name) ? `${name}.` : name!;
	} catch (ex) {
		return "";
	}
}

/**
 * Safely removes a ts-morph node if it exposes a `remove()` method.
 * Forgotten or already-removed nodes are handled gracefully.
 *
 * @param node - The node to remove, or `undefined`.
 * @param noLog - When `true`, suppresses the removal log message.
 * @returns `true` if the node was removed (or was already forgotten),
 *   `false` otherwise.
 */
export function removeNode(node?: Node, noLog?: boolean) {
	if (!node) return false;
	if (node?.wasForgotten()) return true;
	if (isRemoveable(node)) {
		var msg = `${node.getKindName()} ${getFullyQualifiedName(node)} from ${node.getSourceFile().getFilePath()}` as const;
		try {
			node.remove();
			!noLog && console.error(`removed ${msg}`);
			return true;
		} catch (ex) {
			console.error(`Error removing ${msg}: ${ex}`);
		}
	} else {
		console.error(`Node not removeable: ${node.getKindName()}: ${node.print()}}`);
	}
	return false;
}

/**
 * Returns `true` when the type contains an unresolved (`any`/`unknown`-like)
 * component.
 *
 * Recursively checks array element types, union members, intersection members,
 * and object properties. Note: `never` and explicit `any` both return `false`
 * (they are considered resolved).
 *
 * @param _type - The ts-morph `Type` to inspect.
 */
export function isAnyOrUnknown(_type: Type): boolean {
	if (_type.isAny() || _type.isNever()) return false;
	if (_type.isArray()) return _type.getTypeArguments().every(isAnyOrUnknown);
	if (_type.isUnion()) return _type.getUnionTypes().some(isAnyOrUnknown);
	if (_type.isIntersection()) return (_type as Type<ts.IntersectionType>).getIntersectionTypes().some(isAnyOrUnknown);
	if ((_type as Type).isObject()) return (_type as Type<ts.ObjectType>).getProperties().length == 0;
	if ((_type as Type).isClassOrInterface()) return false;
	return false;
}

/**
 * Applies a combined code fix (e.g. `"annotateWithTypeFromJSDoc"`) to the
 * entire source file via the language service and returns the refreshed file.
 *
 * @param sourceFile - The file to fix.
 * @param fixId - The combined fix identifier.
 * @param formatContext - Optional formatting settings.
 * @param preferences - Optional user preferences for the fix.
 * @returns The updated `SourceFile` (re-fetched from the project after the fix).
 */
export function combinedFix(sourceFile: SourceFile, fixId: string, formatContext?: FormatCodeSettings | undefined, preferences?: UserPreferences | undefined): SourceFile {
	var path = sourceFile.getFilePath();
	var _this = sourceFile.getProject();

	try {
		_this
			.getLanguageService()
			.getCombinedCodeFix(path, fixId, formatContext, preferences)
			.applyChanges({ overwrite: true })
			.getChanges()
			.forEach((ch) => {
				var chSf = ch.getSourceFile();
				if (!!chSf) {
					var x = chSf.getDescendantsOfKind(ts.SyntaxKind.EmptyStatement);
					if (x.length > 0) {
						x.forEach((a) => a);
						chSf = _this.getSourceFile(ch.getFilePath());
					}
				}
			});
		/*.getChanges()
		.map(ch => ch.getSourceFile())
		.filter(sf => !!sf)
		.find(sf => sf.getFilePath() == sourceFile.getFilePath()) || sourceFile*/
		//return sourceFile;
	} catch (ex) {
		console.error(`Error getting combined fix ${fixId} for ${path}`, ex);
		//return this.getSourceFile(sourceFile.getFilePath()) || sourceFile;
	}
	return _this.getSourceFile(path)!;
}

export function convertSourceFile(sourceFile: SourceFile, extension: string) {
	var _this = sourceFile.getProject();
	var fileName = sourceFile.getBaseNameWithoutExtension();
	var filePath = _path.dirname(sourceFile.getFilePath());
	sourceFile = createConst(sourceFile);
	var newSf = renameSourceFile(sourceFile, `${filePath}/${fileName}${extension}`, { overwrite: false });
	newSf = transformSourceFile(newSf, [
		(context) => (sourceFile) => {
			const visitor: ts.Visitor = (node) => {
				if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text, false);
				return ts.visitEachChild(node, visitor, context);
			};
			return ts.visitEachChild(sourceFile, visitor, context);
		},
		(context) => (sourceFile) => {
			const visitor: ts.Visitor = (node) => {
				node = ts.visitEachChild(node, visitor, context);
				if (!node) return undefined;
				if (ts.isInJSFile(node)) {
					if (ts.isAsExpression(node)) {
						return ts.addSyntheticLeadingComment(
							ts.factory.createParenthesizedExpression(node.expression),
							ts.SyntaxKind.MultiLineCommentTrivia,
							`* @type {${printNode(node.type)}} `,
							false,
						);
					}
				} else {
					var mNode = createWrappedNode(node, {
						compilerOptions: context.getCompilerOptions(),
						sourceFile,
					});

					if (Node.isExpression(mNode)) {
						let t = getJSDocs(mNode)
							?.getJsDocs()
							.find((j) => j.getTags().find((t) => Node.isJSDocTypeExpression(t)));
						if (Node.isJSDocTypeExpression(t)) {
							return ts.factory.createAsExpression(mNode.compilerNode, t.getTypeNode().compilerNode);
						}
					}
				}

				return node;
			};

			return ts.visitEachChild(sourceFile, visitor, context);
		},
	]);

	if (!isJavascrpt(newSf)) {
		newSf = combinedFix(newSf, "annotateWithTypeFromJSDoc")!;
		newSf.getDescendantsOfKind(ts.SyntaxKind.JSDocTypeExpression).forEach((e) => {
			try {
				e.replaceWithText("");
			} catch (ex) {}
		});
		newSf
			.getDescendantsOfKind(ts.SyntaxKind.JSDoc)
			.filter(Node.isJSDoc)
			.forEach((d) =>
				d.getTags().forEach((t) => {
					if (!isNotEmpty(t.getCommentText())) removeNode(t);
				}),
			);

		newSf
			.getDescendantsOfKind(ts.SyntaxKind.JSDoc)
			.filter(Node.isJSDoc)
			.forEach((d) => {
				if (d.getTags().length == 0 && !isNotEmpty(d.getCommentText())) removeNode(d);
			});

		newSf
			.getDescendants()
			.filter((d) => Node.isTyped(d) && !!d.getTypeNode() && isAnyOrUnknown(d.getType()))
			.forEach((d) => {
				try {
					Node.isTyped(d) && d.removeType();
				} catch (ex) {}
			});

		newSf = createConst(newSf);
	}
	return newSf;
}

export function applyRefactors(sourceFile?: SourceFile, kind?: string, name?: string, formatContext: FormatCodeSettings = {}, preferences?: ts.UserPreferences | undefined) {
	if (!sourceFile) return undefined;
	var _this = sourceFile.getProject();
	var refactors: ts.ApplicableRefactorInfo[] = [];
	function isApplicable(node: Node) {
		if (kind == "refactor.rewrite.string" && (Node.isStringLiteral(node) || Node.isSourceFile(node) || Node.isSyntaxList(node))) return false;
		try {
			var filePath = node.getSourceFile()?.compilerNode.fileName;
			refactors = refactors.concat(
				_this
					.getLanguageService()
					.compilerObject.getApplicableRefactors(filePath, node.compilerNode, preferences, "invoked", kind, false)
					.filter((info) => (!!name ? info.name == name : true))
					.filter((info) => (!!kind ? info.actions.some((action) => action.kind?.startsWith(kind)) : true))
					.filter((info) => !(info.name == "Extract type" && Node.isBooleanKeyword(node))),
			);
			return refactors.length > 0;
		} catch (ex) {
			return false;
		}
	}

	try {
		let node = sourceFile.getFirstDescendant(isApplicable);
		if (!!node && refactors.length > 0) {
			var changes = refactors
				.flatMap((refactor) =>
					refactor.actions
						.filter((action) => (!!kind ? action.kind?.startsWith(kind) : true))
						.flatMap((action) =>
							_this.getLanguageService().getEditsForRefactor(node.getSourceFile(), formatContext, node, refactor.name, action.name, preferences)?.getEdits(),
						),
				)
				.filter((a) => !!a);
			//console.log(`applying refactors "${kind}" on (${node.getKindName()}) "${node.getFullText()}" for ${sourceFile.getFilePath()}: ${changes.length}`)
			sourceFile = applyFileChanges(changes).find((sf) => sf.getFilePath() == sourceFile!.getFilePath());
			return applyRefactors(sourceFile, kind, name);
		}
	} catch (ex) {
		console.error(`error applying refactors "${kind}"}`, ex);
	}
	return sourceFile;
}

function applyFileChanges(changes: FileTextChanges[]) {
	var _this = changes
		.find((c) => c.getSourceFile())
		?.getSourceFile()
		?.getProject();
	return Array.from(
		changes.reduce<Set<string>>((state, curr) => {
			state.add(curr.applyChanges({ overwrite: true })?.getFilePath() || "");
			return state;
		}, new Set()),
	)
		.map((filePath) => _this?.getSourceFile(filePath))
		.filter((a) => !!a)
		.map((sf) => {
			var x = sf.getDescendantsOfKind(ts.SyntaxKind.EmptyStatement);
			if (x.length > 0) {
				x.forEach((a) => a);
				sf.forget();
				//sf = _this.getSourceFile(sf.getFilePath())!;
			}
			return sf;
		});
}

function exprReviver(this: any, key: string, value: unknown): ts.Expression | undefined {
	if (value == null) {
		return ts.factory.createNull();
	}

	try {
		switch (typeof value) {
			case "boolean":
				return value ? ts.factory.createTrue() : ts.factory.createFalse();
			case "number":
				if (key == "kind" && value in StructureKind) {
					return ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("StructureKind"), `${StructureKind[value]}`);
				}
				return value < 0 ?
						ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createNumericLiteral(value * -1))
					:	ts.factory.createNumericLiteral(value);
			case "undefined":
				return !!key ? undefined : ts.factory.createIdentifier("undefined");
			case "function":
				var sf = ts.createSourceFile("generated.js", value + "", ts.ScriptTarget.Latest, undefined);
				return sf.statements.length > 0 && ts.isExpressionStatement(sf.statements[0]) ?
						sf.statements[0].expression
					:	ts.factory.createNoSubstitutionTemplateLiteral(value + "");
			case "object":
				if (ts.isExpression(value as any)) return value as unknown as ts.Expression;
				if (Array.isArray(value)) {
					if (!!key && value.length == 0) return undefined as any;
					return ts.factory.createArrayLiteralExpression(value.map((v, i, arr) => exprReviver.call(arr, `${i}`, v)).filter(isNotEmpty), true);
				}
				return ts.factory.createObjectLiteralExpression(
					Object.keys(value)
						.sort()
						.map((key) => [key, (value as any)[key]] as const)
						.map((e) => {
							var expr = exprReviver.call(value, e[0], e[1]);
							return expr ? ts.factory.createPropertyAssignment(e[0], expr) : undefined;
						})
						.filter(isNotEmpty),
					true,
				);
			case "string":
				if (key == "declarationKind") {
					var declValue = Object.entries(ModuleDeclarationKind).find((e) => e[1] == value);
					if (!!declValue) return ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("ModuleDeclarationKind"), declValue[0]);
				}
				if (value.trim() == "") return !!key ? undefined : ts.factory.createNull();

				return ts.factory.createNoSubstitutionTemplateLiteral(value);
			default:
				break;
		}
	} catch (ex) {
		console.error(`error exprReviver on "${key}": ${typeof value}: ${ex}`);
	}
	return ts.factory.createIdentifier("undefined");
}

/**
 * Generates a human-readable TypeScript source snippet that reconstructs the
 * ts-morph `SourceFileStructure` of the given source file.
 *
 * The output is a `const structure: SourceFileStructure = { ... }` statement
 * printed as formatted TypeScript, suitable for display in the Structure (AST)
 * output tab.
 *
 * @param sf - The compiler-API `ts.SourceFile` to analyse.
 * @returns A trimmed TypeScript source string containing the structure literal.
 */
export function getAstStructure(sf: ts.SourceFile) {
	const sourceFile = createTSMorphSourceFile(sf);

	var expr = JSON.parse(JSON.stringify(sourceFile.getStructure()), exprReviver);

	var sf = ts.createSourceFile(
		"dummy.ts",
		`
import { SourceFileStructure, StructureKind } from "ts-morph";

const structure: SourceFileStructure = ${printSourceText(expr)};
`,
		ts.ScriptTarget.ESNext,
		true,
	);
	/*var sf = ts.factory.createSourceFile([
		ts.factory.createExpressionStatement(expr)
	],
		ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
		ts.NodeFlags.None
	)*/
	var ret = ts
		.createPrinter()
		.printFile(sf)
		.replace(/\s*;\s*$/, "")
		.trim();
	return ret.trim();
}

export function createTSMorphSourceFile(sf: ts.SourceFile, compilerOptions?: ts.CompilerOptions) {
	const project = new Project({ useInMemoryFileSystem: true, compilerOptions });

	var newsf = project.createSourceFile(sf.fileName, printNode(sf), { overwrite: true });
	return newsf;
}

/**
 * Adapts a synchronous ts-morph edit into a compiler transformer factory.
 *
 * The edit runs against an isolated in-memory project. Only the transformed
 * statements are copied back to the original compiler source file, preserving
 * its identity and transformation context.
 */
export function createTSMorphTransform(
	edit: (sourceFile: SourceFile, context: ts.TransformationContext) => SourceFile | void,
): ts.TransformerFactory<ts.SourceFile> {
	return (context) => (sourceFile) => {
		const wrapped = createTSMorphSourceFile(sourceFile, context.getCompilerOptions());
		const transformed = edit(wrapped, context) || wrapped;
		return context.factory.updateSourceFile(sourceFile, transformed.compilerNode.statements);
	};
}
