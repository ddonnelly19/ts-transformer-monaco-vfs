import ts from "typescript";
import { createWrappedNode, Node, printNode } from "ts-morph";

const fixProtoType: ts.TransformerFactory<ts.SourceFile> = (context) => (sourceFile) => {
	const visitor: ts.Visitor = <T extends ts.Node>(
		node: T
	): ts.VisitResult<ts.Node | undefined> => {
		var factory = context.factory;

		if (!node || ts.isEmptyStatement(node)) return undefined;
		var mNode = createWrappedNode(node, {
			sourceFile,
			compilerOptions: context.getCompilerOptions()
		});

		// Convert variable statement lists
		if (Node.isVariableStatement(mNode)) {
			if (mNode.getDeclarations().length == 0) return undefined;
			if (mNode.getDeclarations().length > 1) {
				var varStmt = mNode;
				var stmts = mNode.getDeclarations().reduce(
					(state: ts.VariableStatement[], decl) =>
						state.concat(
							factory.createVariableStatement(
								varStmt.getModifiers().map((m) => m.compilerNode),
								factory.createVariableDeclarationList(
									[
										factory.createVariableDeclaration(
											decl.getName(),
											decl.getExclamationTokenNode()?.compilerNode,
											decl.getTypeNode()?.compilerNode,
											decl.getInitializer()?.compilerNode
										),
									],
									varStmt.getDeclarationList().getFlags()
								)
							)
						),
					[]
				);
				return ts
					.visitNodes(factory.createNodeArray(stmts), visitor)
					.filter((a) => !!a);
			}
			// Convert function statements to declarations
			if (mNode.getDeclarations().length == 1) {
				var stmt = mNode.getDeclarations()[0];
				//console.log(`nodeType for ${getText(stmt.name)}: ${checker.typeToString(type)}`);
				var initializer = stmt.getInitializer();
				if (!!initializer) {
					/*if (Node.isPropertyAccessExpression(initializer) && initializer.getName() == "create") {
						var expression = initializer.getExpression();
						if (!!expression && Node.isIdentifier(expression) && expression.getText() == "Class") {
							return ts.visitNode(factory.createClassDeclaration(
								undefined,
								stmt.getName(),
								undefined,
								undefined,
								[]
							), visitor)
						}
					}*/

					if (Node.isFunctionExpression(initializer)) {
						return ts.visitNode(
							factory.createFunctionDeclaration(
								initializer.getModifiers().map((m) => m.compilerNode),
								initializer.getAsteriskToken()?.compilerNode,
								stmt.getName(),
								initializer
									.getTypeParameters()
									.map((t) => t.compilerNode),
								initializer.getParameters().map((p) => p.compilerNode),
								initializer.getReturnTypeNode()?.compilerNode,
								factory.createBlock(
									initializer.getStatements().map((s) => s.compilerNode)
								)
							),
							visitor
						);
					}

					// clear initializer on blank string;
					if (
						Node.isStringLiteral(initializer) &&
						initializer.getText() == ""
					) {
						return ts
							.visitNodes(
								factory.createNodeArray([
									factory.createVariableStatement(
										mNode.getModifiers().map((m) => m.compilerNode),
										factory.createVariableDeclarationList(
											[
												factory.createVariableDeclaration(
													stmt.getName(),
													stmt.getExclamationTokenNode()?.compilerNode,
													stmt.getTypeNode()?.compilerNode,
													undefined
												),
											],
											mNode.getDeclarationList().getFlags()
										)
									),
								]),
								visitor
							)
							.filter((a) => !!a);
					}
				}
			}
		}

		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text == "getMessage" &&
			node.expression.expression &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text == "gs"
		) {
			if (node.arguments.length == 1) {
				return ts.visitNode(node.arguments[0], visitor);
			}
			if (node.arguments.length == 2) {
				var objArgs = node.arguments[1];
				var strArg = node.arguments[0];
				if (
					ts.isStringLiteral(strArg) &&
					ts.isArrayLiteralExpression(objArgs)
				) {
					var txt = objArgs.elements.reduce((state, curr, index) => {
						var pattern = new RegExp(`\\{${index}\\}`, "gmi");
						return state.replace(pattern, "${" + curr.getText() + "}");
					}, strArg.text);
					return factory.createNoSubstitutionTemplateLiteral(txt, txt);
				}
			}
		}

		try {
			return ts.visitEachChild(node, visitor, context);
		} catch (ex) {
			console.error(
				`Error visiting children for node ${ts.SyntaxKind[node.kind]}: "${printNode(node)}"`,
				ex
			);
			return node;
		}
	};
	try {
		return ts.visitEachChild(sourceFile, visitor, context);		
	} catch (ex) {
		console.error(ex);
		return sourceFile;
	}
}

export default ({}) => fixProtoType