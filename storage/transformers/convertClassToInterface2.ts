/** 
({ host, program, sourceFile }: {
    host: import("typescript").CompilerHost;
    program: import("typescript").Program;
    sourceFile: import("typescript").SourceFile;
}) => ts.SourceFile
*/
import ts from "typescript";

export function classToInterfaceTransformer({ host, program, sourceFile }: {
    host: import("typescript").CompilerHost;
    program: import("typescript").Program;
    sourceFile: import("typescript").SourceFile;
}): ts.TransformerFactory<ts.SourceFile> {
	return context => {
		const factory = context.factory;

		return sourceFile => {
			const statements: ts.Statement[] = [];

			for (const statement of sourceFile.statements) {
				if (
					ts.isClassDeclaration(statement) &&
					statement.name &&
					statement.modifiers?.some(
						m => m.kind === ts.SyntaxKind.DeclareKeyword
					)
				) {
					statements.push(
						...transformClass(statement, factory)
					);
					continue;
				}

				statements.push(statement);
			}

			return factory.updateSourceFile(sourceFile, statements);
		};
	};
}

function transformClass(
	node: ts.ClassDeclaration,
	factory: ts.NodeFactory
): ts.Statement[] {
	const className = node.name!.text;
	const ctorName = `${className}Constructor`;

	const instanceMembers: ts.TypeElement[] = [];
	const constructorMembers: ts.TypeElement[] = [];

	const accessors = collectAccessors(node);

	for (const member of node.members) {
		//
		// constructor
		//
		if (ts.isConstructorDeclaration(member)) {
			constructorMembers.push(
				factory.createConstructSignature(
					node.typeParameters,
					member.parameters,
					factory.createTypeReferenceNode(
						className,
						node.typeParameters?.map(tp =>
							factory.createTypeReferenceNode(tp.name)
						)
					)
				)
			);

			continue;
		}

		//
		// properties
		//
		if (ts.isPropertyDeclaration(member)) {
			const isStatic = member.modifiers?.some(
				m => m.kind === ts.SyntaxKind.StaticKeyword
			);

			const isReadonly = member.modifiers?.some(
				m => m.kind === ts.SyntaxKind.ReadonlyKeyword
			);

			const prop = factory.createPropertySignature(
				isReadonly
					? [factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)]
					: undefined,
				member.name,
				member.questionToken,
				member.type
			);

			(isStatic ? constructorMembers : instanceMembers).push(prop);

			continue;
		}

		//
		// methods
		//
		if (ts.isMethodDeclaration(member)) {
			const isStatic = member.modifiers?.some(
				m => m.kind === ts.SyntaxKind.StaticKeyword
			);

			const method = factory.createMethodSignature(
				undefined,
				member.name,
				member.questionToken,
				member.typeParameters,
				member.parameters,
				member.type
			);

			(isStatic ? constructorMembers : instanceMembers).push(method);

			continue;
		}
	}

	//
	// accessor properties
	//
	for (const accessor of accessors.values()) {
		const target = accessor.isStatic
			? constructorMembers
			: instanceMembers;

		target.push(
			factory.createPropertySignature(
				accessor.readonly
					? [factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)]
					: undefined,
				accessor.name,
				undefined,
				accessor.type
			)
		);
	}

	return [
		factory.createInterfaceDeclaration(
			[factory.createModifier(ts.SyntaxKind.ExportKeyword)],
			className,
			node.typeParameters,
			undefined,
			instanceMembers
		),

		factory.createInterfaceDeclaration(
			[factory.createModifier(ts.SyntaxKind.ExportKeyword)],
			ctorName,
			undefined,
			undefined,
			constructorMembers
		),

		factory.createVariableStatement(
			[factory.createModifier(ts.SyntaxKind.ExportKeyword)],
			factory.createVariableDeclarationList(
				[
					factory.createVariableDeclaration(
						className,
						undefined,
						factory.createTypeReferenceNode(ctorName)
					),
				],
				ts.NodeFlags.Const
			)
		),
	];
}

interface AccessorInfo {
	name: string;
	type?: ts.TypeNode;
	isStatic: boolean;
	hasGetter: boolean;
	hasSetter: boolean;
	readonly: boolean;
}

function collectAccessors(
	node: ts.ClassDeclaration
): Map<string, AccessorInfo> {
	const accessors = new Map<string, AccessorInfo>();

	for (const member of node.members) {
		if (
			!ts.isGetAccessorDeclaration(member) &&
			!ts.isSetAccessorDeclaration(member)
		) {
			continue;
		}

		const name = member.name.getText();

		let existing = accessors.get(name);

		if (!existing) {
			existing = {
				name,
				type: undefined,
				isStatic: !!member.modifiers?.some(
					m => m.kind === ts.SyntaxKind.StaticKeyword
				),
				hasGetter: false,
				hasSetter: false,
				readonly: false,
			};

			accessors.set(name, existing);
		}

		if (ts.isGetAccessorDeclaration(member)) {
			existing.hasGetter = true;
			existing.type = member.type;
		}

		if (ts.isSetAccessorDeclaration(member)) {
			existing.hasSetter = true;

			if (
				!existing.type &&
				member.parameters.length > 0
			) {
				existing.type = member.parameters[0]!.type;
			}
		}
	}

	for (const accessor of accessors.values()) {
		accessor.readonly =
			accessor.hasGetter &&
			!accessor.hasSetter;
	}

	return accessors;
}

export default classToInterfaceTransformer;