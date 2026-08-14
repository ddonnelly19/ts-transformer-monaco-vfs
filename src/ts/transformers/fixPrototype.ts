import { printNode } from "ts-morph";
import ts from "typescript";
import { getModifiers, validProperty } from "../../utils";

function isNodeExtend(exprRight?: ts.Node): exprRight is ts.CallExpression {
	return !!exprRight && ts.isCallExpression(exprRight) && (printNode(exprRight.expression, { "removeComments": true }) == "Object.extendsObject" || printNode(exprRight.expression, { "removeComments": true }) == "Object.extend") && exprRight.arguments.length == 2;
}

export const fixPrototype: ts.TransformerFactory<ts.SourceFile> = (context) => (sourceFile) => {
	const factory = context.factory;
	const visitor: ts.Visitor = (node) => {
		if (!node) 
			return undefined;

		// "prototype"
		if (
			ts.isExpressionStatement(node) &&
			ts.isBinaryExpression(node.expression)
		) {
			var expr = node.expression;
			if (
				expr.operatorToken.kind == ts.SyntaxKind.EqualsToken &&
				ts.isPropertyAccessExpression(expr.left) &&
				expr.left.name.text == "prototype"
			) {
				let exprLeft = expr.left;
				let exprRight = expr.right;
				if (
					isNodeExtend(exprRight) &&
					ts.isObjectLiteralExpression(exprRight.arguments[1])
				) {
					return ts.visitNodes(
						factory.createNodeArray([
							// Object.extendsObject
							factory.createExpressionStatement(
								factory.createBinaryExpression(
									exprLeft,
									expr.operatorToken,
									factory.createCallExpression(
										exprRight.expression,
										undefined,
										[exprRight.arguments[0], exprLeft]
									)
								)
							),
							// prototype assignment
							factory.createExpressionStatement(
								factory.createBinaryExpression(
									exprLeft,
									expr.operatorToken,
									exprRight.arguments[1]
								)
							),
						]),
						visitor
					);
				}
				if (ts.isObjectLiteralExpression(exprRight!)) {
					if (exprRight.properties.length == 0) {
					} else {
						let props = exprRight.properties
							.map((propNode) => {
								if (
									ts.isPropertyAssignment(propNode) ||
									ts.isMethodDeclaration(propNode)
								) {
									var init = ts.isPropertyAssignment(propNode)
										? propNode.initializer
										: factory.createFunctionExpression(
											getModifiers(propNode.modifiers),
											propNode.asteriskToken,
											undefined,
											propNode.typeParameters,
											propNode.parameters,
											propNode.type,
											propNode.body || factory.createBlock([])
										);
									var ret: (ts.ExpressionStatement | ts.JSDoc)[] = [];
									var jsDoc = (propNode as any).jsDoc;
									if (!!jsDoc) {
										if (ts.isJSDoc(jsDoc)) ret.push(jsDoc);
										else ret = ret.concat(jsDoc);
									} else {
									}
									if (
										(ts.isStringLiteral(propNode.name) ||
											ts.isMemberName(propNode.name)) &&
										propNode.name.text.match(validProperty)
									) {
										let assn = factory.createAssignment(
											factory.createPropertyAccessExpression(
												exprLeft,
												propNode.name.text
											),
											init
										);
										ret.push(factory.createExpressionStatement(assn));
									}
									return ret.filter((a) => !!a);
								}
								return [];
							})
							.reduce((a, b) => a.concat(b), [])
							.filter((expr) => !!expr);
						return ts.visitNodes(factory.createNodeArray(props), visitor).filter((a) => !!a);
					}
				}
			}
		}
		return ts.visitEachChild(node, visitor, context);
	};
	return ts.visitEachChild(sourceFile, visitor, context);
}