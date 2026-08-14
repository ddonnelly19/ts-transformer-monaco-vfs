import { Node, createWrappedNode, printNode, SourceFile, SourceFileCreateOptions, SpreadAssignment, PropertyAssignment, ShorthandPropertyAssignment, VariableDeclaration, BinaryExpression, AssignmentExpression, Type, ts, FormatCodeSettings, UserPreferences, FileTextChanges } from "ts-morph";
import { IdentifierString, isEmpty, isNotEmpty, isValidIdentifier } from "../ts/utils";
import { createConsts } from "../ts/transformers/createConsts";
import _path from "path";

type NodeVisitor<TIn extends ts.Node = ts.Node, TOut extends ts.Node | undefined = TIn | undefined> = (node: TIn, visitor: ts.Visitor<TIn, TOut>, context?: ts.TransformationContext, program?: ts.Program) => ts.VisitResult<TOut>;

export function visitNodes<TIn extends ts.Node = ts.Node, TOut extends ts.Node | undefined = TIn | undefined>(visitorFn: NodeVisitor<TIn, TOut>, program?: ts.Program): ts.TransformerFactory<TIn> {
	return (context: ts.TransformationContext) => {
		return (sourceFile: TIn) => {
			var __visitor = (node: any) => {
				try {
					return node && visitorFn(node, __visitor, context, program);
				}
				catch (ex) {
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
export function transformScript<T extends ts.Node = ts.Node>(source: T | T[], visitors: NodeVisitor<T>[], program?: ts.Program, compilerOptions: ts.CompilerOptions | undefined = program?.getCompilerOptions()) {
	return ts.transform<T>(source, visitors.map(v => visitNodes(v, program)), compilerOptions);
}


export function transformSourceFile(sourceFile: SourceFile, transforms: ts.TransformerFactory<ts.SourceFile>[]) {
	var project = sourceFile.getProject();
	return ts.transform(sourceFile.compilerNode, transforms, project.getCompilerOptions())
		.transformed.map((sf) => {
			return project.createSourceFile(sf.fileName, printNode(sf, sf), {
				overwrite: true
			});
		})
		.find((sf) => sf.getFilePath() == sourceFile.getFilePath()) ||
		sourceFile;
}


export function createConst(sf: SourceFile) {
	return transformSourceFile(sf, [createConsts]);
}

export function isJavascrpt(node: Node) {
	return ts.isInJSFile(node.compilerNode);
}

function renameSourceFile(
	sourceFile: SourceFile,
	newPath: string,
	options?: SourceFileCreateOptions
) {
	var project = sourceFile.getProject();
	if (_path.normalize(sourceFile.getFilePath()) == _path.normalize(newPath))
		return sourceFile;
	var newSf = project.createSourceFile(
		newPath,
		sourceFile.getStructure(),
		options
	);
	sourceFile.deleteImmediatelySync();
	return newSf;
}

export function getJSDocs(node: Node) {
	if (!node)
		return undefined;
	if (Node.isJSDocable(node)) {
		return node;
	}
	return node.getFirstAncestor(Node.isJSDocable);
}

export function isRemoveable<T extends Node>(node?: T): node is T & {
	remove(): void;
} {
	return !!node && "remove" in node && typeof node.remove == "function";
}

export type AssignmentNode = SpreadAssignment | PropertyAssignment | ShorthandPropertyAssignment | VariableDeclaration | BinaryExpression | AssignmentExpression<ts.AssignmentExpression<ts.EqualsToken>>

export function isAssignmentExpression(node?: Node): node is AssignmentExpression<ts.AssignmentExpression<ts.EqualsToken>> {
	return !!node && ts.isAssignmentExpression(node.compilerNode, true)
}

export function isAssignment(node: Node | undefined): node is AssignmentNode {
	return Node.isSpreadAssignment(node) || Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node) || Node.isVariableDeclaration(node) || isAssignmentExpression(node) || (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() == ts.SyntaxKind.EqualsToken);
}

export function isNameable<T extends Node<TS>, TS extends ts.Node>(node?: T) {
	return Node.isNode(node) && Node.hasName(node);
}

export function hasNameNode(node: any): node is Node & { getNameNode(): Node } {
	return Node.isNode(node) && !!(node as any).getNameNode && ((node as any).getNameNode instanceof Function);
}

export function nodeEquals<T extends Node>(node1: T, node2?: any): node2 is T {
	if (!Node.isNode(node2))
		return false;
	if (node1.wasForgotten() || node2.wasForgotten())
		return false;
	if (Node.isSourceFile(node1) && Node.isSourceFile(node2))
		return node1.getFilePath().localeCompare(node2.getFilePath()) == 0;
	return nodeEquals(node1.getSourceFile(), node2.getSourceFile())
		&& node1.getKind() == node2.getKind()
		&& node1.getStart() == node2.getStart()
		&& node1.getEnd() == node2.getEnd();
}


export function getFullyQualifiedName<T extends Node>(node?: T, appendDot?: boolean): string {
	if (!node)
		return "";
	try {
		var useBraces = false;
		if (Node.isSourceFile(node) || Node.isNewExpression(node))
			return "";
		if (Node.isExpressionWithTypeArguments(node))
			return getFullyQualifiedName(node.getExpression(), appendDot) || "";
		var name: IdentifierString | undefined = "";
		if (Node.isLeftHandSideExpressioned(node))
			name = `${getFullyQualifiedName(node.getExpression(), Node.hasName(node)) || ""}${Node.hasName(node) ? node.getName() : ""}`

		else if (Node.isPropertySignature(node) && !isValidIdentifier(node.getName())) {
			name = `${getFullyQualifiedName(node.getParent())}[${node.getName()}]`;
		}
		else
			try {
				var sym = node.getSymbol();
				name = sym?.getFullyQualifiedName();
			} catch (ex) {

			}
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
					var parentName = getFullyQualifiedName(parentSym, false) || ""
					return isNotEmpty(parentName) ? `${parentName}["${name}"]${appendDot ? "." : ""}` : appendDot ? `["${name}"].` : `"${name}"`;
				}
				return `${getFullyQualifiedName(parentSym, true) || ""}${appendDot && isNotEmpty(name) ? `${name}.` : name}`;
			}
			if (Node.isLeftHandSideExpressioned(parentSym) && hasNameNode(parentSym))
				return nodeEquals(node, parentSym.getNameNode()) ? getFullyQualifiedName(parentSym, appendDot) :
					"";
			else if (isAssignment(parentSym) || Node.isTypeQuery(parentSym) || Node.isHeritageClause(parentSym) || Node.isExpressionWithTypeArguments(parentSym))
				parentSym = undefined;
			else if (!appendDot && (Node.isQualifiedName(parentSym) || Node.isPropertyAccessExpression(parentSym))) {
				name = parentSym.getText();
			}
			else {
				if (Node.isIdentifier(node) || Node.isQualifiedName(node) || Node.isPropertyAccessExpression(node)) {
					return `${getFullyQualifiedName(parentSym, true) || ""}${node.getText()}`;
				}
				if (isNameable(node)) {
					return `${getFullyQualifiedName(parentSym, true) || ""}${node.getName()}`;
				}
			}

			//return parentSym?.getFullyQualifiedName();
		}
		return appendDot && isNotEmpty(name) ? `${name}.` : name!
	}
	catch (ex) {
		return "";
	}
};

export function removeNode(node?: Node, noLog?: boolean) {
	if (!node)
		return false;
	if (node?.wasForgotten())
		return true;
	if (isRemoveable(node)) {
		var msg = `${node.getKindName()} ${getFullyQualifiedName(node)} from ${node.getSourceFile().getFilePath()}` as const;
		try {
			node.remove();
			!noLog && console.error(`removed ${msg}`);
			return true;
		}
		catch (ex) {
			console.error(`Error removing ${msg}: ${ex}`);
		}
	} else {
		console.error(`Node not removeable: ${node.getKindName()}: ${node.print()}}`);
	}
	return false;
}

export function isAnyOrUnknown(_type: Type): boolean {
	if (_type.isAny() || _type.isNever())
		return false;
	if (_type.isArray())
		return _type.getTypeArguments().every(isAnyOrUnknown);
	if (_type.isUnion())
		return _type.getUnionTypes().some(isAnyOrUnknown);
	if (_type.isIntersection())
		return (_type as Type<ts.IntersectionType>).getIntersectionTypes().some(isAnyOrUnknown);
	if ((_type as Type).isObject())
		return (_type as Type<ts.ObjectType>).getProperties().length == 0;
	if ((_type as Type).isClassOrInterface())
		return false;
	return false;
};

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
	var newSf = renameSourceFile(
		sourceFile,
		`${filePath}/${fileName}${extension}`,
		{ overwrite: false }
	);
	newSf = transformSourceFile(newSf, [
		(context) => (sourceFile) => {
			const visitor: ts.Visitor = (node) => {
				if (ts.isStringLiteral(node))
					return ts.factory.createStringLiteral(node.text, false);
				return ts.visitEachChild(node, visitor, context);
			}
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
							false
						);
					}
				} else {
					var mNode = createWrappedNode(node, {
						compilerOptions: context.getCompilerOptions(),
						sourceFile
					});

					if (Node.isExpression(mNode)) {
						let t = getJSDocs(mNode)
							?.getJsDocs()
							.find((j) =>
								j.getTags().find((t) => Node.isJSDocTypeExpression(t))
							);
						if (Node.isJSDocTypeExpression(t)) {
							return ts.factory.createAsExpression(
								mNode.compilerNode,
								t.getTypeNode().compilerNode
							);
						}
					}
				}

				return node;
			};

			return ts.visitEachChild(sourceFile, visitor, context);
		},
	]);

	/*newSf.getDescendants()
		.filter(Node.isIdentifier)
		.forEach(node => {
			var refs = node
				.findReferences()
				.flatMap(r => r.getReferences())
				.filter(r => r.isWriteAccess())
				.map(r => r.getNode().getParent());
			var defs = node.getDefinitions()
				
		})*/

	if (!isJavascrpt(newSf)) {
		newSf = combinedFix(newSf, "annotateWithTypeFromJSDoc")!;
		newSf
			.getDescendantsOfKind(ts.SyntaxKind.JSDocTypeExpression)
			.forEach((e) => {
				try {
					e.replaceWithText("");
				} catch (ex) { }
			});
		newSf.getDescendantsOfKind(ts.SyntaxKind.JSDoc)
			.filter(Node.isJSDoc)
			.forEach((d) =>
				d.getTags().forEach((t) => {
					if (!isNotEmpty(t.getCommentText())) removeNode(t)
				})
			);

		newSf.getDescendantsOfKind(ts.SyntaxKind.JSDoc)
			.filter(Node.isJSDoc)
			.forEach((d) => {
				if (d.getTags().length == 0 && !isNotEmpty(d.getCommentText()))
					removeNode(d);
			});

		newSf
			.getDescendants()
			.filter(
				(d) =>
					Node.isTyped(d) && !!d.getTypeNode() && isAnyOrUnknown(d.getType())
			)
			.forEach((d) => {
				try {
					Node.isTyped(d) && d.removeType();
				} catch (ex) { }
			});

		newSf = createConst(newSf);
	}
	return newSf;
}

export function applyRefactors(sourceFile?: SourceFile, kind?: string, name?: string, formatContext: FormatCodeSettings = {}, preferences?: ts.UserPreferences | undefined) {
	if (!sourceFile)
		return undefined;
	var _this = sourceFile.getProject();
	var refactors: ts.ApplicableRefactorInfo[] = [];
	function isApplicable(node: Node) {
		if (
			kind == "refactor.rewrite.string" &&
			(Node.isStringLiteral(node) ||
				Node.isSourceFile(node) ||
				Node.isSyntaxList(node))
		)
			return false;
		refactors = refactors.concat(
			_this
				.getLanguageService()
				.compilerObject.getApplicableRefactors(
					node.getSourceFile()?.getFilePath(),
					node.compilerNode,
					preferences,
					"invoked",
					kind,
					false
				)
				.filter((info) => (!!name ? info.name == name : true))
				.filter((info) =>
					!!kind
						? info.actions.some((action) => action.kind?.startsWith(kind))
						: true
				)
				.filter(
					(info) =>
						!(info.name == "Extract type" && Node.isBooleanKeyword(node))
				)
		);
		return refactors.length > 0;
	}

	try {
		let node = sourceFile.getFirstDescendant(isApplicable);
		if (!!node && refactors.length > 0) {
			var changes = refactors
				.flatMap((refactor) =>
					refactor.actions
						.filter((action) =>
							!!kind ? action.kind?.startsWith(kind) : true
						)
						.flatMap((action) =>
							_this
								.getLanguageService()
								.getEditsForRefactor(
									node.getSourceFile(),
									formatContext,
									node,
									refactor.name,
									action.name,
									preferences
								)
								?.getEdits()
						)
				)
				.filter((a) => !!a);
			//console.log(`applying refactors "${kind}" on (${node.getKindName()}) "${node.getFullText()}" for ${sourceFile.getFilePath()}: ${changes.length}`)
			sourceFile = applyFileChanges(changes).find(sf => sf.getFilePath() == sourceFile!.getFilePath())
			return applyRefactors(sourceFile, kind, name);
		}
	} catch (ex) {
		console.error(
			`error applying refactors "${kind}" for ${sourceFile?.getFilePath()}`,
			ex
		);
	}
	return sourceFile;
}

function applyFileChanges(changes: FileTextChanges[]) {
	var _this = changes.find(c => c.getSourceFile())?.getSourceFile()?.getProject();
	return Array.from(
		changes.reduce<Set<string>>((state, curr) => {
			state.add(curr.applyChanges({ overwrite: true })?.getFilePath() || "");
			return state;
		}, new Set())
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