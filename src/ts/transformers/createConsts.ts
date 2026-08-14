import ts from "typescript";
import { isAsConstExpression, isEmpty, TSisAssignment, TSgetIdentifier } from "../../utils";


const canBeConst = (node: ts.Expression): node is ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | ts.StringLiteralLike | ts.TemplateExpression | ts.TaggedTemplateExpression => {
	if (ts.isParenthesizedExpression(node))
		return false;
	if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isStringLiteralOrTemplate(node)) {
		if (ts.isRegularExpressionLiteral(node))
			return false;
		if (ts.isObjectLiteralExpression(node) && node.properties.length == 0)
			return false;
		if (ts.isStringLiteralLike(node) && isEmpty(node.text))
			return false;
		if (ts.isArrayLiteralExpression(node) && node.elements.length == 0)
			return false;
		if (ts.findAncestor(node, isAsConstExpression))
			return false;
		if (ts.findAncestor(node, ts.isElementAccessExpression))
			return false;
		var parent = node.parent;
		if (!!parent) {
			parent = ts.findAncestor(parent, (_node) => !!_node && !ts.isParenthesizedExpression(_node))!

			if (ts.isReturnStatement(parent))
				return true;

			else if (TSisAssignment(parent)) {
				if (ts.isVariableDeclaration(parent) && !ts.isVariableStatement(parent.parent.parent))
					return false;
				if (ts.isForInOrOfStatement(parent.parent))
					return false;
				let left = TSgetIdentifier(parent);
				if (left && left != node) {
					return true;
					//let identifier = left.getText();

					/*let references = [];//(ls.findReferences(left.getSourceFile().fileName, left.pos) || [])
						.flatMap(r => r.references)
						.filter(r => !r.isDefinition && r.isWriteAccess)
						.map(r => ts.getTokenAtPosition(sf.getProject().getSourceFile(r.fileName)!.compilerNode, r.textSpan.start));
	
					let values = new Set(references
						//.filter(r => !r.isDefinition() && r.isWriteAccess())
						.map(r => r.parent)
						.filter(TSisAssignment)
						.map(a => checker.typeToString(checker.getTypeAtLocation(TSgetInitializer(a)!)))
						.filter(a => !!a))
	
	
					if (references.length == 0)
						return true;
					if (values.size <= 1)
						return true;*/
				}
			}
		}
	}
	return false;
}

const createConsts: ts.TransformerFactory<ts.SourceFile> = (context) =>
	(sourceFile) => {
		var visitor: ts.Visitor = (node) => {
			try {
				if (ts.isExpression(node)) {
					if (isAsConstExpression(node))
						return node;

					let parent = node.parent;
					if (ts.isParenthesizedExpression(parent))
						return node;

					var factory = context.factory;				

					if (canBeConst(node)) {
						console.info(`converting ${ts.SyntaxKind[node.kind]} / ${ts.SyntaxKind[node.parent.kind]} to const: ${node.parent.getText()}`)
						return ts.isInJSFile(node) ?
							ts.addSyntheticLeadingComment(ts.isParenthesizedExpression(node) ? node : factory.createParenthesizedExpression(node), ts.SyntaxKind.MultiLineCommentTrivia, `* @type {const} `, false) :
							factory.createAsExpression(node, factory.createTypeReferenceNode(factory.createIdentifier("const")));
					}
				}
				return ts.visitEachChild(node, visitor, context);
			}
			catch (ex) {
				return node;
			}
		}
		return ts.visitEachChild(sourceFile, visitor, context);
	}

export { createConsts };