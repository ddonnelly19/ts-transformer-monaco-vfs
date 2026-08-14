import ts from "typescript";

const BUILTIN_TYPE_NAMES = new Set([
	"Array",
	"ReadonlyArray",
	"Promise",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"Record",
	"Partial",
	"Required",
	"Pick",
	"Omit",
	"Exclude",
	"Extract",
	"NonNullable",
	"ReturnType",
	"InstanceType",
	"Parameters",
	"ConstructorParameters",
	"Awaited",
	"Date",
	"RegExp",
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"Intl",
	"JSON",
	"Math",
	"String",
	"Number",
	"Boolean",
	"Object",
	"Function",
	"Symbol",
	"BigInt",
	"Readonly",
	"ThisType",
	"Uppercase",
	"Lowercase",
	"Capitalize",
	"Uncapitalize",
	"TemplateStringsArray",
	"ArrayLike",
	"Iterable",
	"Iterator",
	"Generator",
	"ReadonlyMap",
	"ReadonlySet",
	"Proxy",
	"ProxyConstructor",
]);

function createShellInterfacesForUnresolvedTypesTransformer(
	program: ts.Program,
): ts.TransformerFactory<ts.SourceFile> {
	const checker = program.getTypeChecker();

	return (context) => {
		const { factory } = context;

		return (sourceFile) => {
			const declaredTypeNames = new Set<string>();
			const unresolvedTypeNames = new Set<string>();

			const recordTypeDeclarationNames = (node: ts.Node): void => {
				if (
					ts.isInterfaceDeclaration(node) ||
					ts.isClassDeclaration(node) ||
					ts.isTypeAliasDeclaration(node) ||
					ts.isEnumDeclaration(node)
				) {
					if (node.name && ts.isIdentifier(node.name)) {
						declaredTypeNames.add(node.name.text);
					}
				}
				ts.forEachChild(node, recordTypeDeclarationNames);
			};

			const isResolvableTypeReference = (name: ts.EntityName): boolean => {
				try {
					const symbol = checker.getSymbolAtLocation(name);
					return !!symbol;
				} catch (ex) {
					return false;
				}
			};

			const getRootIdentifierText = (name: ts.EntityName): string => {
				let current: ts.EntityName = name;
				while (ts.isQualifiedName(current)) {
					current = current.left;
				}
				return current.text;
			};

			const collectUnresolvedTypeRefs = (node: ts.Node): void => {
				if (!node)
					return;
				if (ts.isTypeReferenceNode(node) && ts.isEntityName(node.typeName)) {
					if (!isResolvableTypeReference(node.typeName)) {
						unresolvedTypeNames.add(getRootIdentifierText(node.typeName));
					}
				}
				ts.forEachChild(node, collectUnresolvedTypeRefs);
			};

			recordTypeDeclarationNames(sourceFile);
			collectUnresolvedTypeRefs(sourceFile);

			const shellNames = [...unresolvedTypeNames].filter(
				(name) =>
					!declaredTypeNames.has(name) &&
					!BUILTIN_TYPE_NAMES.has(name)
			);

			if (shellNames.length === 0) {
				return sourceFile;
			}

			shellNames.sort((a, b) => a.localeCompare(b));

			const shellInterfaces = shellNames.map((name) =>
				factory.createInterfaceDeclaration(
					undefined,
					factory.createIdentifier(name),
					undefined,
					undefined,
					[]
				)
			);

			let insertAt = 0;
			for (let i = 0; i < sourceFile.statements.length; i++) {
				const stmt = sourceFile.statements[i];
				if (stmt && (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt))) {
					insertAt = i + 1;
				}
			}

			const nextStatements = [
				...sourceFile.statements.slice(0, insertAt),
				...shellInterfaces,
				...sourceFile.statements.slice(insertAt),
			];

			return ts.factory.updateSourceFile(sourceFile, nextStatements);
		};
	};
}

const xform =  ({ host, program, sourceFile }: {
    host: import("typescript").CompilerHost;
    program: import("typescript").Program;
    sourceFile: import("typescript").SourceFile;
}) => createShellInterfacesForUnresolvedTypesTransformer(program);

export default xform;
