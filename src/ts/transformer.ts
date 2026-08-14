import ts from "typescript"
import { addJSDocs } from "./utils";

export default (
	ts: typeof import("typescript"),
	system: import("typescript").System,
	compilerHost: import("typescript").CompilerHost,
	languageServiceHost: import("typescript").LanguageServiceHost,
	options: import("typescript").CompilerOptions,
	inputFileName: string
) => {
	//8016
	/*registerCodeFix(
		"convetTypeScriptType",
		[8010],
		"Convert Typescript Type reference",
		ts.DiagnosticCategory.Error,
		function (context, changeTracker, diags, fixedNodes) {
			const token = findNodeOfType(context.sourceFile, context.span.start, ts.hasType);
			if (!!token && ts.isInJSFile(token) && !!token.type && ts.canHaveJSDoc(token) && ts.tryAddToSet(fixedNodes, token)) {

				changeTracker.addJSDocTags(context.sourceFile, token, [
					ts.factory.createJSDocTypeTag(
						undefined,
						ts.factory.createJSDocTypeExpression(token.type),
						undefined
					)
				])
				var typeToken = findNodeOfType(context.sourceFile, context.span.start, ts.isTypeNode);
				if (typeToken && ts.tryAddToSet(fixedNodes, typeToken)) {
					changeTracker.deleteNode(context.sourceFile, typeToken);
				}
			}

		}
	)

	var ls = ts.createLanguageService(languageServiceHost)
	var actions = ls.getCombinedCodeFix({ "fileName": "input.js", "type": "file" }, "convetTypeScriptType", {}, {});
	applyFileTextChanges(system, actions.changes);*/

	ts.transform(
		ts.createSourceFile(inputFileName, system.readFile(inputFileName)!, ts.ScriptTarget.ESNext, true),
		[
			(context) => {
				//var program = ts.createProgram([inputFileName], context.getCompilerOptions(), ts.createCompilerHost(context.getCompilerOptions(), true));
				//var checker = program.getTypeChecker();
				const { factory } = context;
				const visit: ts.Visitor = (node) => {
					if (ts.isFunctionLikeDeclaration(node)) {
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

					} else if (ts.isParameter(node)) {
						node = factory.updateParameterDeclaration(node, node.modifiers, node.dotDotDotToken, node.name, undefined, undefined, node.initializer);
					}
					else if (ts.hasType(node) && ts.canHaveJSDoc(node) && !ts.getJSDocTags(node).find(ts.isJSDocTypeTag)) {

						node = addJSDocs(node, factory.createJSDocTypeTag(
							undefined,
							factory.createJSDocTypeExpression(node.type!),
							undefined
						));
						/*return ts.visitNode({
							...addJSDocs(node, factory.createJSDocTypeTag(
								undefined,
								factory.createJSDocTypeExpression(node.type!),
								undefined
							)),
							type: undefined,
							pos: -1,
							end: -1
						}, visit)*/
					}
					else if (ts.isTypeNode(node))
						return undefined;

					else if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text == "")
						return undefined;

					return ts.visitEachChild(node, visit, context);
				};
				return (sf) => {

					return (ts.visitNode(sf, visit) || sf) as typeof sf
				}
			}
		]
	)
		.transformed
		.forEach(sf => system.writeFile(sf.fileName, ts.createPrinter().printFile(sf)));
}