import ts from "typescript";

export function implicitReturnFactory(
    context: ts.TransformationContext
): ts.Transformer<ts.SourceFile> {
    const { factory } = context;

  

    function rewriteBody(body: ts.Block): ts.Block {
        const statements = [...body.statements];

        if (statements.length === 0) {
            return body;
        }

        const last = statements[statements.length - 1]!;

        if (ts.isExpressionStatement(last)) {
            statements[statements.length - 1] =
                factory.createReturnStatement(last.expression);

            return factory.updateBlock(body, statements);
        }

        if (ts.isFunctionDeclaration(last)) {
            statements[statements.length - 1] =
                factory.createReturnStatement(
                    factory.createFunctionExpression(
                        ts.getModifiers(last),
                        last.asteriskToken,
                        last.name,
                        last.typeParameters,
                        last.parameters,
                        last.type,
                        rewriteBody(last.body || factory.createBlock([]))
                    )
                );

            return factory.updateBlock(body, statements);
        }

        return body;
    }

    function visitor(node: ts.Node): ts.VisitResult<ts.Node> {
        if (ts.isFunctionDeclaration(node) && node.body) {
            return factory.updateFunctionDeclaration(
                node,
                node.modifiers,
                node.asteriskToken,
                node.name,
                node.typeParameters,
                node.parameters,
                node.type,
                rewriteBody(node.body)
            );
        }

        if (ts.isFunctionExpression(node) && node.body) {
            return factory.updateFunctionExpression(
                node,
                node.modifiers,
                node.asteriskToken,
                node.name,
                node.typeParameters,
                node.parameters,
                node.type,
                rewriteBody(node.body)
            );
        }

        if (ts.isMethodDeclaration(node) && node.body) {
            return factory.updateMethodDeclaration(
                node,
                node.modifiers,
                node.asteriskToken,
                node.name,
                node.questionToken,
                node.typeParameters,
                node.parameters,
                node.type,
                rewriteBody(node.body)
            );
        }

        return ts.visitEachChild(node, visitor, context);
    }

    return sourceFile =>
        ts.visitNode(sourceFile, visitor) as ts.SourceFile;
}

export default ({ }) => implicitReturnFactory;
