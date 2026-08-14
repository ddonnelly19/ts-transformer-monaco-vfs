import ts from "typescript";
import { applyJsDoc, getAllLeadingComments, hasAnyFlags, hasFlags, printNode } from "./utils";


function hasJSDocTypeExpression<T extends object>(node: T): node is T & { typeExpression: ts.JSDocTypeExpression } {
	return "typeExpression" in node && ts.isJSDocTypeExpression(node.typeExpression as any)
}
const removeAnyType = (program: ts.Program) => (context: ts.TransformationContext) => {
	const factory = context.factory;
	const checker = program.getTypeChecker();
	return (sourceFile: ts.SourceFile) => {
		function isTypeAnyOrUnknown(type?: ts.Type) {
			if (!type)
				return false;
			if (hasAnyFlags(type.flags, ts.TypeFlags.Any, ts.TypeFlags.Undefined, ts.TypeFlags.Unknown))
				return true;
			if (type.isClassOrInterface())
				return false;
			if (checker.isArrayType(type))
				return isTypeAnyOrUnknown((type as ts.TypeReference).target)
			if (type.isUnion())
				return type.types.some(isTypeAnyOrUnknown);
			if (type.isIntersection())
				return type.types.every(isTypeAnyOrUnknown);
			if (hasFlags(type.flags, ts.TypeFlags.Object))
				return (type as ts.ObjectType).getProperties().length == 0;
			return false;
		}

		function isAnyOrUnknown(typeNode?: ts.TypeNode): boolean {
			if (!typeNode)
				return false;
			if (ts.isTypeAliasDeclaration(typeNode))
				return false;
			if (ts.isConditionalTypeNode(typeNode))
				return false;
			if (ts.isRestTypeNode(typeNode))
				return false;
			if (ts.isArrayTypeNode(typeNode)) {
				return isAnyOrUnknown(typeNode.elementType)
			}
			if (ts.isUnionTypeNode(typeNode))
				return typeNode.types.some(isAnyOrUnknown);
			if (ts.isIntersectionTypeNode(typeNode))
				return typeNode.types.every(isAnyOrUnknown);
			if (ts.isTypeReferenceNode(typeNode))
				return false;
			return isTypeAnyOrUnknown(checker.getTypeFromTypeNode(typeNode));
		};
		var visitor: ts.Visitor = (_node) => {
			var node = ts.visitEachChild(_node, visitor, context, ts.visitNodes);
			if (!node)
				return undefined;
			
			
			if (ts.canHaveJSDoc(node)) {
				var comments = getAllLeadingComments(node);	
				if (comments.length > 0)			
					return applyJsDoc(node, comments);				
			}

			/*if (ts.isJSDoc(node) && !!node.tags) {
				var tags = ts.visitNodes(factory.createNodeArray(node.tags), visitor)
					.filter(ts.isJSDocTag);
				if (tags.length == 0 && (!node.comment || node.comment.length == 0))
					return undefined;
				return factory.createJSDocComment(
					node.comment,
					tags
				)
			}*/

			if (false && ts.hasJSDocNodes(node)) {
				var docs1 = ts.getJSDocCommentsAndTags(node)
				var docs = ts.visitNodes(factory.createNodeArray(docs1), visitor)
					.filter(d => ts.isJSDoc(d) || ts.isJSDocTag(d));

				node = applyJsDoc(node, docs.map(printNode));
			}
			if (hasJSDocTypeExpression(node) && isAnyOrUnknown(node.typeExpression.type))
				return undefined;
			if (ts.isTypeAliasDeclaration(node))
				return node;
			if (ts.isTypeNode(node) && isAnyOrUnknown(node)) {
				return undefined;
			}

			return node
		};
		return ts.visitEachChild(sourceFile, visitor, context);
	};
};

export default ({program}) => removeAnyType(program);