import ts from "typescript";
import { createStringConcat, isNodeAssignableToString } from "../utils";


const transformStringConcat: (program: ts.Program) => ts.TransformerFactory<ts.SourceFile> = (program) => (context) => (sourceFile) => {
	const factory = context.factory;
//	var program = ts.createProgram([sourceFile.fileName], context.getCompilerOptions(), ts.createCompilerHost(context.getCompilerOptions()));
	const typeChecker = program.getTypeChecker();
	var visitor: ts.Visitor = (node) => {
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
				if (ts.isTemplateTail(span.literal) && span.literal.text == "") {
					return ts.visitNode(createStringConcat("", span.expression), visitor);
				}
			}

			return ts.visitEachChild(node, visitor, context);
		} catch (ex) {
			console.error(ex);
			return node;
		}
	}

	return ts.visitEachChild(sourceFile, visitor, context);

}
export default  ({ host, program, sourceFile }: {
    host: import("typescript").CompilerHost;
    program: import("typescript").Program;
    sourceFile: import("typescript").SourceFile;
}) => transformStringConcat(program);