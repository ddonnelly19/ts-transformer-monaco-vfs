import ts from "typescript";

interface ClassMethodInfo {
	name: string;
	isStatic: boolean;

	parameters: readonly ts.ParameterDeclaration[];
	body: ts.Block;

	sourceStatement: ts.Statement;
	sourceNode: ts.Node;
}

interface ClassPropertyInfo {
	name: string;
	isStatic: boolean;

	isReadonly?: boolean;

	initializer?: ts.Expression;

	sourceStatement: ts.Statement;
	sourceNode: ts.Node;
}

interface ClassInfo {
	name: string;

	rootStatement: ts.Statement;

	definingScope: ScopeContext;

	targetScope?: ScopeContext;

	shouldEmitInClosure?: boolean;

	ctor?: ts.FunctionDeclaration;

	initializeMethod?: ClassMethodInfo;

	baseClass?: string;

	instanceMethods: ClassMethodInfo[];
	staticMethods: ClassMethodInfo[];
	properties: ClassPropertyInfo[];

	consumedStatements: Set<ts.Statement>;
}

interface ScopeContext {
	parent?: ScopeContext;

	node: ts.SourceFile | ts.Block | ts.ModuleBlock;

	classes: Map<string, ClassInfo>;
}

function resolveClass(scope: ScopeContext, name: string): ClassInfo | undefined {
	let current: ScopeContext | undefined = scope;

	while (current) {
		const cls = current.classes.get(name);

		if (cls) {
			return cls;
		}

		current = current.parent;
	}

	return undefined;
}

function discoverClassRoots(statements: readonly ts.Statement[], scope: ScopeContext): void {
	for (const statement of statements) {
		if (ts.isClassLike(statement) && statement.name) {
			scope.classes.set(statement.name.text, {
				name: statement.name.text,

				rootStatement: statement,

				definingScope: scope,

				instanceMethods: [],
				staticMethods: [],
				properties: [],

				consumedStatements: new Set([statement]),
			});			
		} else 	if (ts.isFunctionDeclaration(statement) && statement.name) {
			scope.classes.set(statement.name.text, {
				name: statement.name.text,

				rootStatement: statement,

				definingScope: scope,

				instanceMethods: [],
				staticMethods: [],
				properties: [],

				consumedStatements: new Set([statement]),
			});
		}
	}
}

function discoverMembers(statements: readonly ts.Statement[], scope: ScopeContext): void {
	for (const statement of statements) {
		if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
			const assignment = statement.expression;

			detectInheritance(assignment, scope);

			detectPrototypeMethod(statement, assignment, scope);

			detectPrototypeProperty(statement, assignment, scope);

			detectStaticMethod(statement, assignment, scope);

			detectStaticProperty(statement, assignment, scope);
		}
	}
}

function processScope(node: ts.SourceFile | ts.Block | ts.ModuleBlock, scope: ScopeContext): void {
	discoverClassRoots(node.statements, scope);

	discoverMembers(node.statements, scope);

	for (const statement of node.statements) {
		ts.forEachChild(statement, (child) => {
			if (ts.isBlock(child) || ts.isModuleBlock(child)) {
				const childScope: ScopeContext = {
					parent: scope,
					node: child,
					classes: new Map(),
				};

				processScope(child, childScope);
			}
		});
	}
}

function emitStatements(sourceFile: ts.SourceFile, statements: readonly ts.Statement[], scope: ScopeContext, factory: ts.NodeFactory): ts.Statement[] {
	const output: ts.Statement[] = [];

	const roots = new Map<ts.Statement, ClassInfo>();

	const consumed = new Set<ts.Statement>();

	for (const cls of scope.classes.values()) {
		roots.set(cls.rootStatement, cls);

		for (const stmt of cls.consumedStatements) {
			consumed.add(stmt);
		}
	}

	for (const statement of statements) {
		const cls = roots.get(statement);

		if (cls) {
			output.push(emitClass(sourceFile, cls, factory));

			continue;
		}

		if (consumed.has(statement)) {
			continue;
		}

		output.push(statement);
	}

	return output;
}

function transformScope<T extends ts.Node>(sourceFile: ts.SourceFile, scopeNode: T, scope: ScopeContext, factory: ts.NodeFactory): T {
	if (!(ts.isSourceFile(scopeNode) || ts.isBlock(scopeNode) || ts.isModuleBlock(scopeNode))) {
		return scopeNode;
	}

	const statements = scopeNode.statements;

	const rewritten = emitStatements(sourceFile, statements, scope, factory);

	if (ts.isSourceFile(scopeNode)) {
		return factory.updateSourceFile(scopeNode, rewritten) as unknown as T;
	}

	if (ts.isBlock(scopeNode)) {
		return factory.updateBlock(scopeNode, rewritten) as unknown as T;
	}

	if (ts.isModuleBlock(scopeNode)) {
		return factory.updateModuleBlock(scopeNode, rewritten) as unknown as T;
	}

	return scopeNode;
}

export function prototypeToClassFactory(): ts.TransformerFactory<ts.SourceFile> {
	return (context) => {
		const { factory } = context;

		return (sourceFile) => {
			const rootScope: ScopeContext = {
				node: sourceFile,
				classes: new Map(),
			};

			//
			// Discover all classes +
			// scope relationships
			//
			processScope(sourceFile, rootScope);

			//
			// Rewrite file
			//
			const statements = emitStatements(sourceFile, sourceFile.statements, rootScope, factory);

			return factory.updateSourceFile(sourceFile, statements);
		};
	};
}

function copyComments(sourceFile: ts.SourceFile, from: ts.Node, to: ts.Node): void {
	if (hasSyntheticComments(to)) return;
	const text = sourceFile.getFullText();

	for (const range of ts.getLeadingCommentRanges(text, from.pos) ?? []) {
		ts.addSyntheticLeadingComment(
			to,
			range.kind,
			text.substring(range.pos + (range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? 2 : 2), range.end - (range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? 0 : 2)),
			true,
		);
	}

	for (const range of ts.getTrailingCommentRanges(text, from.end) ?? []) {
		ts.addSyntheticTrailingComment(
			to,
			range.kind,
			text.substring(range.pos + (range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? 2 : 2), range.end - (range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? 0 : 2)),
			true,
		);
	}

	//ts.setTextRange(to, from);
}

function hasSyntheticComments(node: ts.Node): boolean {
	return !!(ts.getSyntheticLeadingComments(node)?.length || ts.getSyntheticTrailingComments(node)?.length);
}

function copySyntheticComments(from: ts.Node, to: ts.Node): void {
	const leading = ts.getSyntheticLeadingComments(from);

	if (leading) {
		for (const comment of leading) {
			ts.addSyntheticLeadingComment(to, comment.kind, comment.text, comment.hasTrailingNewLine);
		}
	}

	const trailing = ts.getSyntheticTrailingComments(from);

	if (trailing) {
		for (const comment of trailing) {
			ts.addSyntheticTrailingComment(to, comment.kind, comment.text, comment.hasTrailingNewLine);
		}
	}
}

function emitMethod(sourceFile: ts.SourceFile, method: ClassMethodInfo, factory: ts.NodeFactory): ts.MethodDeclaration {
	const result = factory.createMethodDeclaration(
		method.isStatic ? [factory.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined,
		undefined,
		method.name,
		undefined,
		undefined,
		method.parameters,
		undefined,
		method.body,
	);

	copyComments(sourceFile, method.sourceNode, result);

	return result;
}

function emitProperty(sourceFile: ts.SourceFile, property: ClassPropertyInfo, factory: ts.NodeFactory): ts.PropertyDeclaration {
	const modifiers: ts.Modifier[] = [];

	if (property.isStatic) {
		modifiers.push(factory.createModifier(ts.SyntaxKind.StaticKeyword));
	}

	let initializer = property.initializer;

	if (property.isReadonly && initializer) {
		initializer =
			ts.isInJSFile(initializer) ?
				ts.addSyntheticLeadingComment(
					ts.isParenthesizedExpression(initializer) ? initializer : factory.createParenthesizedExpression(initializer),
					ts.SyntaxKind.MultiLineCommentTrivia,
					"* @type {const} ",
					false,
				)
			:	factory.createAsExpression(initializer, factory.createTypeReferenceNode("const"));
	}

	const result = factory.createPropertyDeclaration(modifiers.length ? modifiers : undefined, property.name, undefined, undefined, initializer);

	copyComments(sourceFile, property.sourceNode, result);

	return result;
}

function emitClass(sourceFile: ts.SourceFile, cls: ClassInfo, factory: ts.NodeFactory): ts.ClassDeclaration {
	const members: ts.ClassElement[] = [];

	const ctor = createMergedConstructor(cls, factory);

	if (ctor) {
		members.push(ctor);
	}

	for (const method of cls.staticMethods) {
		members.push(emitMethod(sourceFile, method, factory));
	}

	for (const property of cls.properties) {
		members.push(emitProperty(sourceFile, property, factory));
	}

	for (const method of cls.instanceMethods) {
		members.push(emitMethod(sourceFile, method, factory));
	}
	
	const classDecl = factory.createClassDeclaration(undefined, cls.name, undefined, createHeritage(cls, factory), members);

	if (cls.ctor) {
		copyComments(sourceFile, cls.ctor, classDecl);
	}

	return classDecl;
}

function createMergedConstructor(cls: ClassInfo, factory: ts.NodeFactory): ts.ConstructorDeclaration | undefined {
	const parameters = cls.initializeMethod?.parameters ?? [];

	const statements: ts.Statement[] = [];

	if (cls.ctor?.body) {
		statements.push(...cls.ctor.body.statements);
	}

	if (cls.initializeMethod?.body) {
		statements.push(...cls.initializeMethod.body.statements);
	}

	if (parameters.length === 0 && statements.length === 0) {
		return undefined;
	}

	return factory.createConstructorDeclaration(undefined, parameters, factory.createBlock(statements, true));
}

function createHeritage(cls: ClassInfo, factory: ts.NodeFactory): readonly ts.HeritageClause[] | undefined {
	if (!cls.baseClass) {
		return undefined;
	}

	return [factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [factory.createExpressionWithTypeArguments(factory.createIdentifier(cls.baseClass), undefined)])];
}

function detectInheritance(assignment: ts.BinaryExpression, scope: ScopeContext): void {
	if (!ts.isPropertyAccessExpression(assignment.left) || assignment.left.name.text !== "prototype" || !ts.isIdentifier(assignment.left.expression)) {
		return;
	}

	const cls = resolveClass(scope, assignment.left.expression.text);

	if (!cls) {
		return;
	}

	if (cls.definingScope !== scope) {
		cls.shouldEmitInClosure = true;
		cls.targetScope = scope;
	}

	if (!ts.isCallExpression(assignment.right)) {
		return;
	}

	const call = assignment.right;

	if (!ts.isPropertyAccessExpression(call.expression)) {
		return;
	}

	const target = call.expression;

	if (!ts.isIdentifier(target.expression) || target.expression.text !== "Object" || target.name.text !== "create") {
		return;
	}

	if (call.arguments.length !== 1) {
		return;
	}

	const arg = call.arguments[0];

	if (ts.isPropertyAccessExpression(arg) && arg.name.text === "prototype" && ts.isIdentifier(arg.expression)) {
		cls.baseClass = arg.expression.text;
	}
}

function detectPrototypeProperty(statement: ts.Statement, assignment: ts.BinaryExpression, scope: ScopeContext): void {
	if (!ts.isPropertyAccessExpression(assignment.left) || !ts.isPropertyAccessExpression(assignment.left.expression)) {
		return;
	}

	const prototypeExpr = assignment.left.expression;

	if (prototypeExpr.name.text !== "prototype" || !ts.isIdentifier(prototypeExpr.expression)) {
		return;
	}

	if (ts.isFunctionExpression(assignment.right) || ts.isArrowFunction(assignment.right)) {
		return;
	}

	const cls = resolveClass(scope, prototypeExpr.expression.text);

	if (!cls) {
		return;
	}

	if (cls.definingScope !== scope) {
		cls.shouldEmitInClosure = true;
		cls.targetScope = scope;
	}

	if (cls.consumedStatements.has(statement)) {
		return;
	}

	cls.properties.push({
		name: assignment.left.name.text,
		isStatic: false,
		isReadonly: assignment.left.name.text === "type",
		initializer: assignment.right,
		sourceStatement: statement,
		sourceNode: statement,
	});

	cls.consumedStatements.add(statement);
}

function detectPrototypeMethod(statement: ts.Statement, assignment: ts.BinaryExpression, scope: ScopeContext): void {
	if (!ts.isPropertyAccessExpression(assignment.left) || !ts.isPropertyAccessExpression(assignment.left.expression)) {
		return;
	}

	const proto = assignment.left.expression;

	if (proto.name.text !== "prototype" || !ts.isIdentifier(proto.expression)) {
		return;
	}

	if (!ts.isFunctionExpression(assignment.right)) {
		return;
	}

	const cls = resolveClass(scope, proto.expression.text);

	if (!cls) {
		return;
	}

	if (cls.definingScope !== scope) {
		cls.shouldEmitInClosure = true;
		cls.targetScope = scope;
	}

	if (cls.consumedStatements.has(statement)) {
		return;
	}

	const method: ClassMethodInfo = {
		name: assignment.left.name.text,
		isStatic: false,
		parameters: assignment.right.parameters,
		body: assignment.right.body,
		sourceStatement: statement,
		sourceNode: statement,
	};

	if (method.name === "initialize") {
		cls.initializeMethod = method;
	} else {
		cls.instanceMethods.push(method);
	}

	cls.consumedStatements.add(statement);
}

function detectStaticProperty(statement: ts.Statement, assignment: ts.BinaryExpression, scope: ScopeContext): void {
	if (!ts.isPropertyAccessExpression(assignment.left)) {
		return;
	}

	const lhs = assignment.left;

	if (lhs.name.text === "prototype") {
		return;
	}

	if (!ts.isIdentifier(lhs.expression)) {
		return;
	}

	const cls = resolveClass(scope, lhs.expression.text);

	if (!cls) {
		return;
	}

	if (cls.definingScope !== scope) {
		cls.shouldEmitInClosure = true;
		cls.targetScope = scope;
	}

	if (cls.consumedStatements.has(statement)) {
		return;
	}

	if (ts.isFunctionExpression(assignment.right) || ts.isArrowFunction(assignment.right)) {
		return;
	}

	cls.properties.push({
		name: lhs.name.text,
		isStatic: true,
		isReadonly: isStaticConstant(lhs.name.text, assignment.right),
		initializer: assignment.right,
		sourceStatement: statement,
		sourceNode: statement,
	});

	cls.consumedStatements.add(statement);
}

function isStaticConstant(name: string, value: ts.Expression): boolean {
	if (name.toUpperCase() === name) {
		return true;
	}

	return ts.isStringLiteral(value) || ts.isNumericLiteral(value);
}

function detectStaticMethod(statement: ts.Statement, assignment: ts.BinaryExpression, scope: ScopeContext): void {
	if (!ts.isPropertyAccessExpression(assignment.left)) {
		return;
	}

	if (assignment.left.name.text === "prototype") {
		return;
	}

	if (!ts.isIdentifier(assignment.left.expression) || !ts.isFunctionExpression(assignment.right)) {
		return;
	}

	const cls = resolveClass(scope, assignment.left.expression.text);

	if (!cls) {
		return;
	}

	if (cls.definingScope !== scope) {
		cls.shouldEmitInClosure = true;
		cls.targetScope = scope;
	}

	if (cls.consumedStatements.has(statement)) {
		return;
	}

	cls.staticMethods.push({
		name: assignment.left.name.text,
		isStatic: true,
		parameters: assignment.right.parameters,
		body: assignment.right.body,
		sourceStatement: statement,
		sourceNode: statement,
	});

	cls.consumedStatements.add(statement);
}

export function classCreateToFunctionFactory(): ts.TransformerFactory<ts.SourceFile> {
	return (context) => (sf) => {
		const { factory } = context;

		const visit: ts.Visitor = (node) => {
			if (ts.isVariableStatement(node)) {
				const decls = node.declarationList.declarations;

				if (decls.length === 1) {
					const decl = decls[0]!;

					if (
						ts.isIdentifier(decl.name) &&
						decl.initializer &&
						ts.isCallExpression(decl.initializer) &&
						ts.isPropertyAccessExpression(decl.initializer.expression) &&
						ts.isIdentifier(decl.initializer.expression.expression) &&
						decl.initializer.expression.expression.text === "Class" &&
						decl.initializer.expression.name.text === "create"
					) {
						return factory.createFunctionDeclaration(
							undefined,
							undefined,
							decl.name.text,
							undefined,
							[],
							undefined,
							factory.createBlock(
								[
									/*factory.createExpressionStatement(
															factory.createBinaryExpression(factory.createPropertyAccessExpression(factory.createThis(), "type"), factory.createToken(ts.SyntaxKind.EqualsToken), factory.createStringLiteral(className)),
														),*/
								],
								true,
							),
						);
					}
				}
			}

			return ts.visitEachChild(node, visit, context);
		};

		return ts.visitNode(sf, visit) as ts.SourceFile;
	};
}
export function prototypeObjectLiteralExpansionFactory(): ts.TransformerFactory<ts.SourceFile> {
	return (context) => {
		const { factory } = context;

		const visit: ts.Visitor = (node) => {
			if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)) {
				const assignment = node.expression;

				if (
					ts.isPropertyAccessExpression(assignment.left) &&
					ts.isIdentifier(assignment.left.expression) &&
					assignment.left.name.text === "prototype" &&
					ts.isObjectLiteralExpression(assignment.right)
				) {
					const className = assignment.left.expression;

					return assignment.right.properties
						.filter(ts.isPropertyAssignment)
						.map((property) =>
							factory.createExpressionStatement(
								factory.createBinaryExpression(
									factory.createPropertyAccessExpression(factory.createPropertyAccessExpression(className, "prototype"), property.name.getText()),
									factory.createToken(ts.SyntaxKind.EqualsToken),
									property.initializer,
								),
							),
						);
				}
			}

			return ts.visitEachChild(node, visit, context);
		};

		return (sourceFile) => {
			const statements: ts.Statement[] = [];

			for (const stmt of sourceFile.statements) {
				const result = ts.visitNode(stmt, visit);

				if (Array.isArray(result)) {
					statements.push(...result);
				} else {
					statements.push(result as ts.Statement);
				}
			}

			return factory.updateSourceFile(sourceFile, statements);
		};
	};
}

export function extendsObjectNormalizationFactory(): ts.TransformerFactory<ts.SourceFile> {
	return (context) => {
		const { factory } = context;

		return (sourceFile) => {
			const output: ts.Statement[] = [];

			for (const stmt of sourceFile.statements) {
				if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
					const assignment = stmt.expression;

					if (
						ts.isPropertyAccessExpression(assignment.left) &&
						assignment.left.name.text === "prototype" &&
						ts.isIdentifier(assignment.left.expression) &&
						ts.isCallExpression(assignment.right) &&
						ts.isPropertyAccessExpression(assignment.right.expression)
					) {
						const target = assignment.right.expression;

						if (ts.isIdentifier(target.expression) && target.expression.text === "Object" && target.name.text === "extendsObject") {
							const className = assignment.left.expression;

							const parent = assignment.right.arguments[0];

							const members = assignment.right.arguments[1];

							output.push(
								factory.createExpressionStatement(
									factory.createBinaryExpression(
										factory.createPropertyAccessExpression(className, "prototype"),
										factory.createToken(ts.SyntaxKind.EqualsToken),
										factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier("Object"), "create"), undefined, [
											factory.createPropertyAccessExpression(parent as ts.Expression, "prototype"),
										]),
									),
								),
							);

							if (ts.isObjectLiteralExpression(members)) {
								for (const property of members.properties) {
									if (ts.isPropertyAssignment(property)) {
										output.push(
											factory.createExpressionStatement(
												factory.createBinaryExpression(
													factory.createPropertyAccessExpression(factory.createPropertyAccessExpression(className, "prototype"), property.name.getText()),
													factory.createToken(ts.SyntaxKind.EqualsToken),
													property.initializer,
												),
											),
										);
									}
								}
							}

							continue;
						}
					}
				}

				output.push(stmt);
			}

			return factory.updateSourceFile(sourceFile, output);
		};
	};
}

function transformAll(transformers: ts.TransformerFactory<ts.SourceFile>[]): ts.TransformerFactory<ts.SourceFile> {
	return (context) => (sourceFile) => ts.transform(sourceFile, transformers).transformed.find((t) => t.fileName == sourceFile.fileName) || sourceFile;
}

export default ({}) => transformAll([classCreateToFunctionFactory(), prototypeObjectLiteralExpansionFactory(), extendsObjectNormalizationFactory(), prototypeToClassFactory()]);
