import ts from "typescript";
import { getAllLeadingComments, getModifiers, makeJsDocText, validProperty } from "../utils";


function isNodeExtend(exprRight?: ts.Node): exprRight is ts.CallExpression {
	return !!exprRight &&
		ts.isCallExpression(exprRight) &&
		ts.isPropertyAccessExpression(exprRight.expression) &&
		ts.isIdentifier(exprRight.expression.expression) &&
		exprRight.expression.expression.text == "Object" &&
		((exprRight.expression.name.text == "extendsObject" ||
			exprRight.expression.name.text == "extends") && exprRight.arguments.length == 2);
}

const fixPrototype = (program: ts.Program) => (context: ts.TransformationContext) => (sourceFile: ts.SourceFile) => {
	const factory = context.factory;
	const visitor: ts.Visitor = (node) => {
		if (!node)
			return undefined;

		// "prototype"
		if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)) {
			var expr = node.expression;
			if (
				expr.operatorToken.kind == ts.SyntaxKind.EqualsToken &&
				ts.isPropertyAccessExpression(expr.left) &&
				expr.left.name.text == "prototype"
			) {
				let exprLeft = expr.left;
				let exprRight = expr.right;
				if (isNodeExtend(exprRight) && ts.isObjectLiteralExpression(exprRight.arguments[1]!)) {
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
										[exprRight.arguments[0]!, exprLeft]
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
							.flatMap((propNode) => {
								if (ts.isPropertyAssignment(propNode) || ts.isMethodDeclaration(propNode)) {
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
									var ret: (ts.ExpressionStatement | ts.JSDoc | ts.JSDocTag)[] = [];
									/*	var jsDoc = ts.getJSDocCommentsAndTags(propNode);
										if (!!jsDoc) {
											ret = ret.concat([...ts.getJSDocCommentsAndTags(propNode)])
										} else {
										}*/
									if ((ts.isStringLiteral(propNode.name) || ts.isMemberName(propNode.name)) && propNode.name.text.match(validProperty)) {
										let assn = factory.createAssignment(
											factory.createPropertyAccessExpression(
												exprLeft,
												propNode.name.text
											),
											init
										);

										var stmt = factory.createExpressionStatement(assn);
										var comments = getAllLeadingComments(propNode);
										if (comments.length > 0)
											ts.addSyntheticLeadingComment(stmt, ts.SyntaxKind.MultiLineCommentTrivia, makeJsDocText(comments), true);
										ret.push(stmt);
									}
									return ret.filter((a) => !!a);
								}
								return [];
							})
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

export default fixPrototype;