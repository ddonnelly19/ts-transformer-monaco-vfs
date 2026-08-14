import ts from "typescript";
import { createWrappedNode } from "ts-morph";
import { applyRefactors } from "../../src/ts-morph/tsmorphUtils";

//import { isAsConstExpression, isEmpty, TSisAssignment, TSgetIdentifier } from "./utils";

function isNodeAssignableToString(
	node: ts.Expression,
	checker: ts.TypeChecker,
	strict: boolean = false
) {
	if (ts.isStringLiteralOrTemplate(node))
		return true;
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
	//if (!ret)
	//	console.warn(`isNodeAssignableToString: ${printNode(node)}: ${checker.typeToString(nodeType)}: ${ret}`);
	return ret;
}

function createStringConcat(left: ts.Expression | string, right: ts.Expression | ts.Expression[]) {
	return ts.factory.createCallExpression(
		ts.factory.createPropertyAccessExpression(
			typeof left == "string" ? ts.factory.createStringLiteral(left) : left,
			"concat"
		),
		undefined,
		Array.isArray(right) ? right : [right]
	)
}

const xformer: (program: ts.Program) => ts.TransformerFactory<ts.SourceFile> = 
	(_program) =>
		(context) =>
			(sourceFile) => {	
				var mSourceFile = createWrappedNode(sourceFile, {
					compilerOptions: context.getCompilerOptions(),
					typeChecker:_program.getTypeChecker(),
					sourceFile: sourceFile
				})				
				//const factory = context.factory;
				mSourceFile = applyRefactors(mSourceFile, "refactor.rewrite.string") || mSourceFile;
				var program = mSourceFile.getProject().getProgram().compilerObject;
				sourceFile = mSourceFile.compilerNode;
				
				const typeChecker = program.getTypeChecker();

				var visitor: ts.Visitor = (node: ts.Node) => {
					if (!node)
						return undefined;
					try {
						if (ts.isBinaryExpression(node) && ts.isPlusToken(node.operatorToken)) {
							//if (ts.isStringLiteralLike(node.left) && !(ts.isStringLiteralLike(node.right) || ts.isNumericLiteral(node.right) || ts.isBooleanLiteral(node.right))) {
							if (isNodeAssignableToString(node.left, typeChecker) && !isNodeAssignableToString(node.right, typeChecker)) {
								return ts.visitNode(createStringConcat(node.left, node.right), visitor);
							}
							if (isNodeAssignableToString(node.right, typeChecker) && !isNodeAssignableToString(node.left, typeChecker)) {
								//if (ts.isStringLiteralLike(node.right) && !(ts.isStringLiteralLike(node.left) || ts.isNumericLiteral(node.left) || ts.isBooleanLiteral(node.left))) {
								return ts.isStringLiteralLike(node.right) && node.right.text == "" ?
									ts.visitNode(createStringConcat("", node.left), visitor) :
									ts.visitNode(createStringConcat("", [node.left, node.right]), visitor);
							}
						}

						if (ts.isTemplateExpression(node) && node.head.text == "" && node.templateSpans.length == 1) {
							var span = node.templateSpans[0];
							if (!!span && ts.isTemplateTail(span.literal) && span.literal.text == "") {
								return ts.visitNode(createStringConcat("", span.expression), visitor);
							}
						}

						return ts.visitEachChild(node, visitor, context);
					} catch (ex) {
						console.error(ex);
						return node;
					}
				}			
				
				//return sourceFile;
				return ts.visitEachChild(sourceFile, visitor, context);
			};

export default xformer;