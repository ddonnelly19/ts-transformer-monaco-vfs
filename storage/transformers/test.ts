import ts from "typescript";
import { addJSDocs } from "./utils";

const testTransform: ts.TransformerFactory<ts.SourceFile> = (context) => {
	//var program = ts.createProgram([inputFileName], context.getCompilerOptions(), ts.createCompilerHost(context.getCompilerOptions(), true));
	//var checker = program.getTypeChecker();
	const { factory } = context;
	const visit: ts.Visitor = (node) => {
		if (!node)
			return undefined;

		if (ts.isParenthesizedExpression(node) && ts.isParenthesizedExpression(node.expression))
			node = node.expression;

		if (ts.isAsExpression(node)) {
			node = addJSDocs(
				factory.createParenthesizedExpression(node.expression),
				factory.createJSDocTypeTag(undefined, factory.createJSDocTypeExpression(node.type)),
				false
			)
		}
		else if (ts.isFunctionLikeDeclaration(node)) {
			node = {
				...addJSDocs(node, [
					...ts.getEffectiveTypeParameterDeclarations(node)
						.map(a =>
							factory.createJSDocTemplateTag(
								undefined,
								a.constraint ? factory.createJSDocTypeExpression(a.constraint) : undefined,
								[factory.createTypeParameterDeclaration(a.modifiers, a.name, undefined, a.default)]
							)),
					...node.parameters.map(p => factory.createJSDocParameterTag(
						undefined,
						ts.isEntityName(p.name) ? p.name : factory.createIdentifier(""),
						!!p.questionToken,
						p.type ? factory.createJSDocTypeExpression(p.type) : undefined,
						false
					)),
					...(node.type ? [factory.createJSDocReturnTag(undefined, factory.createJSDocTypeExpression(node.type))] : [])
				]),
				typeParameters: undefined
			} as ts.FunctionLikeDeclaration

		}
		else if (ts.hasTypeArguments(node)) {
			node.typeArguments
		}
		else if (ts.isParameter(node)) {
			node = factory.updateParameterDeclaration(node, node.modifiers, node.dotDotDotToken, node.name, undefined, undefined, node.initializer);
		}
		else if (ts.hasType(node) && ts.canHaveJSDoc(node) && !ts.getJSDocTags(node).find(ts.isJSDocTypeTag)) {

			node = addJSDocs(node, factory.createJSDocTypeTag(
				undefined,
				factory.createJSDocTypeExpression(node.type!),
				undefined
			));
		}
		else if (ts.isTypeNode(node))
			return undefined;

		return ts.visitEachChild(node, visit, context);
	};
	return (sf) => {

		return (ts.visitNode(sf, visit) || sf) as typeof sf
	}
}

export default ({}) => testTransform