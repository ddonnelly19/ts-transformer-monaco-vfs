/** 
({ host, program, sourceFile }: {
    host: import("typescript").CompilerHost;
    program: import("typescript").Program;
    sourceFile: import("typescript").SourceFile;
}) => ts.SourceFile
*/
import ts from "typescript";
import {sortMembers, isAmbientContext} from "./utils";

/**
 * Returns a TypeScript `TransformerFactory` that replaces every class declaration
 * with three declarations:
 *
 *   1. `interface ClassName { … }`                              – instance members
 *   2. `interface ClassNameConstructor { new(…): ClassName; … }` – static + constructor signatures
 *   3. `declare var ClassName: ClassNameConstructor;`
 *
 * Rules:
 *  - `private` / `#private` members are omitted.
 *  - `protected` members are included (they are visible to sub-types).
 *  - `abstract` and `declare` modifiers are stripped from the class; only
 *    `export` / `default` are forwarded to the instance interface.
 *  - The class `extends` clause becomes an `extends` clause on the instance interface.
 *  - The class `implements` clause is dropped (interfaces cannot implement).
 *  - Index signatures are moved to the instance interface.
 *  - Getter accessors become read-only property signatures.
 *  - Setter-only accessors become writable property signatures.
 *  - If no explicit constructor is declared, a default `new(): ClassName` signature
 *    is added to the constructor interface.
 *  - Nested classes (inside namespaces / modules) are transformed recursively.
 */
function classToInterfaceTransformer({ host, program, sourceFile }: {
    host: import("typescript").CompilerHost;
    program: import("typescript").Program;
    sourceFile: import("typescript").SourceFile;
}): ts.TransformerFactory<ts.SourceFile> {
	return (context) => {
		const { factory } = context;

		return (sourceFile) => {
			function visit(node: ts.Node): ts.VisitResult<ts.Node> {
				if (ts.isClassLike(node)) {
					return transformClass(node);
				}
				return ts.visitEachChild(node, visit, context);
			}

			function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
				return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(
					modifier => modifier.kind === kind
				);
			}

			function getNodeModifiers(node: ts.Node): readonly ts.Modifier[] | undefined {
				if (!ts.canHaveModifiers(node)) {
					return undefined;
				}
				return ts.getModifiers(node);
			}

			function isPrivateMember(member: ts.ClassElement): boolean {
				if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) {
					return true;
				}
				return !!member.name && ts.isPrivateIdentifier(member.name);
			}

			function isStaticMember(member: ts.ClassElement): boolean {
				return hasModifier(member, ts.SyntaxKind.StaticKeyword);
			}

			function unknownType(): ts.KeywordTypeNode {
				return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
			}

			function transformClass(node: ts.ClassLikeDeclaration): ts.Node[] {
				const name = node.name?.text ?? "AnonymousClass";
				const ctorName = `${name}Constructor`;
				const typeParams = node.typeParameters;

				// Type arguments for self-referencing (e.g. Array<T> where T is a type param).
				const typeArgs = typeParams?.map(tp =>
					factory.createTypeReferenceNode(tp.name, undefined)
				);

				const instanceMembers: ts.TypeElement[] = [];
				const ctorMembers: ts.TypeElement[] = [];
				let hasExplicitCtor = false;

				// Track getter names so we can skip duplicate setter-only entries.
				const getterNames = new Set<string>();

				for (const member of node.members) {
					if (isPrivateMember(member)) continue;

					const isStatic = isStaticMember(member);
					const target = isStatic ? ctorMembers : instanceMembers;

					if (ts.isConstructorDeclaration(member)) {
						hasExplicitCtor = true;
						// Skip private constructors (already filtered above via modifier check,
						// but a class can have multiple overloads — keep all public ones).
						ctorMembers.push(
							factory.createConstructSignature(
								typeParams,
								member.parameters,
								factory.createTypeReferenceNode(name, typeArgs)
							)
						);
					} else if (ts.isPropertyDeclaration(member)) {
						const readonlyMod = hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)
							? [factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)]
							: undefined;
						target.push(
							factory.createPropertySignature(
								readonlyMod,
								member.name,
								member.questionToken,
								member.type ?? unknownType()
							)
						);
					} else if (ts.isMethodDeclaration(member)) {
						target.push(
							factory.createMethodSignature(
								undefined,
								member.name,
								member.questionToken,
								member.typeParameters,
								member.parameters,
								member.type ?? unknownType()
							)
						);
					} else if (ts.isGetAccessorDeclaration(member)) {
						const keyText = member.name && ts.isIdentifier(member.name)
							? member.name.text
							: undefined;
						if (keyText) getterNames.add(keyText);
						target.push(
							factory.createPropertySignature(
								[factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
								member.name,
								undefined,
								member.type ?? unknownType()
							)
						);
					} else if (ts.isSetAccessorDeclaration(member)) {
						// Only emit a writable property signature when there is no paired getter
						// (otherwise the getter already covers the property).
						const keyText = member.name && ts.isIdentifier(member.name)
							? member.name.text
							: undefined;
						if (!keyText || !getterNames.has(keyText)) {
							const paramType = member.parameters[0]?.type ?? unknownType();
							target.push(
								factory.createPropertySignature(
									undefined,
									member.name,
									undefined,
									paramType
								)
							);
						}
					} else if (ts.isIndexSignatureDeclaration(member)) {
						instanceMembers.push(
							factory.createIndexSignature(
								undefined,
								member.parameters,
								member.type
							)
						);
					}
				}

				// Default constructor signature when the class has none.
				if (!hasExplicitCtor) {
					ctorMembers.unshift(
						factory.createConstructSignature(
							typeParams,
							[],
							factory.createTypeReferenceNode(name, typeArgs)
						)
					);
				}

				// `prototype` property on the constructor interface.
				/*ctorMembers.push(
					factory.createPropertySignature(
						[factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
						factory.createIdentifier("prototype"),
						undefined,
						factory.createTypeReferenceNode(name, typeArgs)
					)
				);*/

				// Build heritage: extends clause on instance interface.
				const extendsClause = node.heritageClauses?.find(
					h => h.token === ts.SyntaxKind.ExtendsKeyword
				);

				// Only propagate export / default modifiers.
				const nodeModifiers = getNodeModifiers(node);
				const exportModifiers: ts.Modifier[] | undefined = isAmbientContext(node) ? undefined : nodeModifiers?.filter(
					modifier => modifier.kind === ts.SyntaxKind.ExportKeyword
						|| modifier.kind === ts.SyntaxKind.DefaultKeyword
				)

				const instanceIface = factory.createInterfaceDeclaration(
					exportModifiers?.length ? exportModifiers : undefined,
					name,
					typeParams,
					extendsClause
						? [factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, extendsClause.types)]
						: undefined,
					sortMembers(instanceMembers)
				);

				const ctorIface = factory.createInterfaceDeclaration(
					undefined,
					ctorName,
					undefined,
					extendsClause
						? [factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, extendsClause.types.map(t => ts.factory.createExpressionWithTypeArguments(ts.factory.createTypeOfExpression(t), undefined)))]
						: undefined,
					sortMembers(ctorMembers)
				);

				const varStatement = factory.createVariableStatement(
					exportModifiers,
					factory.createVariableDeclarationList(
						[factory.createVariableDeclaration(
							factory.createIdentifier(name),
							undefined,
							factory.createIntersectionTypeNode([
								...[...extendsClause?.types || []]
									.map(t => t.expression)
									.filter(e => ts.isEntityName(e))
									.map(e => factory.createTypeQueryNode(
										factory.createIdentifier(e.text),
										undefined
									)),
								factory.createTypeReferenceNode(ctorName, undefined)]),
							undefined
						)],
						ts.NodeFlags.None
					)
				);

				return [instanceIface, ctorIface, varStatement];
			}

			return ts.visitNode(sourceFile, visit) as ts.SourceFile;
		};
	};
}
export default classToInterfaceTransformer;