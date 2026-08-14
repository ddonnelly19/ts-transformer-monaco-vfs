import ts from "typescript";
import { getAllLeadingComments, replaceJsDoc } from "./utils";

const fixComments = (program: ts.Program) => (context: ts.TransformationContext) => (sourceFile: ts.SourceFile) => {
	const factory = context.factory;
	const visitor: ts.Visitor = (node) => {
		if (!node)
			return undefined;

		if (ts.canHaveJSDoc(node)) {
			var comments = getAllLeadingComments(node);
			if (comments.length > 0)
				node = replaceJsDoc(node, comments, comments.length == 1);
		} else {
			
		}

		return ts.visitEachChild(node, visitor, context);
	};
	return ts.visitEachChild(sourceFile, visitor, context);
}

export default ({program}: any) => fixComments(program);