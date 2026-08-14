import ts from "typescript";
import { createProgramFromSourceFile } from "./utils";

export default ({ host, program, sourceFile }: {
    host: import("typescript").CompilerHost;
    program: import("typescript").Program;
    sourceFile: import("typescript").SourceFile;
}) => (context: ts.TransformationContext) => {
	const factory = context.factory;
	const checker = program.getTypeChecker();
	return (sourceFile: ts.SourceFile) => {

		var visitor: ts.Visitor = (node) => {     
			if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) {
				try {
					var prog2 = createProgramFromSourceFile(`var a: ${node.literal.text}`, "temp.ts");
					var checker2 = prog2.getTypeChecker();
					var sym = checker2.resolveName("a", undefined, ts.SymbolFlags.All, false);
					if (sym) {
						var jsonType = checker2.typeToTypeNode(checker2.getTypeOfSymbol(sym), undefined, ts.NodeBuilderFlags.NoTruncation);
						if (jsonType && ts.isTypeLiteralNode(jsonType))
							return jsonType
					}
				}
				catch (ex) {
					console.error(ex)
				}
			}

			return ts.visitEachChild(node, visitor, context, ts.visitNodes);
		};
		return ts.visitEachChild(sourceFile, visitor, context);
	};
};