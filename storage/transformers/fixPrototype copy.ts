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

	ctor?: ts.FunctionDeclaration;

	classCreateStatement?: ts.VariableStatement;

	initializeMethod?: ClassMethodInfo;

	baseClass?: string;

	instanceMethods: ClassMethodInfo[];
	staticMethods: ClassMethodInfo[];
	properties: ClassPropertyInfo[];

	consumedStatements: Set<ts.Statement>;
}

function detectClassCreate(statement: ts.Statement, classes: Map<string, ClassInfo>): void {
	if (!ts.isVariableStatement(statement)) {
		return;
	}

	for (const decl of statement.declarationList.declarations) {
		if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) {
			continue;
		}

		const call = decl.initializer;

		if (!ts.isPropertyAccessExpression(call.expression)) {
			continue;
		}

		const target = call.expression;

		if (!ts.isIdentifier(target.expression) || target.expression.text !== "Class" || target.name.text !== "create") {
			continue;
		}

		classes.set(decl.name.text, {
			name: decl.name.text,
			classCreateStatement: statement,
			instanceMethods: [],
			staticMethods: [],
			properties: [],
			consumedStatements: new Set([statement]),
		});
	}
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

	if (cls.classCreateStatement) {
		statements.push(
			factory.createExpressionStatement(
				factory.createBinaryExpression(
					factory.createPropertyAccessExpression(factory.createThis(), "type"),
					factory.createToken(ts.SyntaxKind.EqualsToken),
					factory.createStringLiteral(cls.name),
				),
			),
		);
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

function detectInheritance(assignment: ts.BinaryExpression, classes: Map<string, ClassInfo>): void {
	if (!ts.isPropertyAccessExpression(assignment.left) || assignment.left.name.text !== "prototype" || !ts.isIdentifier(assignment.left.expression)) {
		return;
	}

	const cls = classes.get(assignment.left.expression.text);

	if (!cls) {
		return;
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

function detectPrototypeProperty(statement: ts.Statement, assignment: ts.BinaryExpression, classes: Map<string, ClassInfo>): void {
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

	const cls = classes.get(prototypeExpr.expression.text);

	if (!cls) {
		return;
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

function detectExtendsObject(statement: ts.Statement, assignment: ts.BinaryExpression, classes: Map<string, ClassInfo>): void {
	if (!ts.isPropertyAccessExpression(assignment.left) || assignment.left.name.text !== "prototype" || !ts.isIdentifier(assignment.left.expression)) {
		return;
	}

	const cls = classes.get(assignment.left.expression.text);

	if (!cls) {
		return;
	}

	if (!ts.isCallExpression(assignment.right)) {
		return;
	}

	const call = assignment.right;

	if (!ts.isPropertyAccessExpression(call.expression)) {
		return;
	}

	const target = call.expression;

	if (!ts.isIdentifier(target.expression) || target.expression.text !== "Object" || !["extendsObject", "extend"].includes(target.name.text)) {
		return;
	}

	if (call.arguments.length < 2) {
		return;
	}

	const parentArg = call.arguments[0];

	if (ts.isIdentifier(parentArg)) {
		cls.baseClass = parentArg.text;
	}

	const membersArg = call.arguments[1];

	if (!ts.isObjectLiteralExpression(membersArg)) {
		cls.consumedStatements.add(statement);
		return;
	}

	// delegate to common handler

	processPrototypeObjectLiteral(cls, statement, membersArg);

	cls.consumedStatements.add(statement);
}

function processPrototypeObjectLiteral(cls: ClassInfo, statement: ts.Statement, objectLiteral: ts.ObjectLiteralExpression): void {
	for (const member of objectLiteral.properties) {
		//
		// Ignore spread syntax
		//
		if (ts.isSpreadAssignment(member)) {
			continue;
		}

		//
		// foo: function () {}
		// foo: () => {}
		//
		if (ts.isPropertyAssignment(member) && (ts.isFunctionExpression(member.initializer) || ts.isArrowFunction(member.initializer))) {
			const fn = member.initializer;

			const body = ts.isBlock(fn.body) ? fn.body : ts.factory.createBlock([ts.factory.createReturnStatement(fn.body)], true);

			const method: ClassMethodInfo = {
				name: member.name.getText(),
				isStatic: false,
				parameters: fn.parameters,
				body,
				sourceStatement: statement,
				sourceNode: member,
			};

			if (method.name === "initialize") {
				cls.initializeMethod = method;
			} else {
				cls.instanceMethods.push(method);
			}

			continue;
		}

		//
		// foo() {}
		//
		if (ts.isMethodDeclaration(member)) {
			const method: ClassMethodInfo = {
				name: member.name.getText(),
				isStatic: false,
				parameters: member.parameters,
				body: member.body ?? ts.factory.createBlock([], true),
				sourceStatement: statement,
				sourceNode: member,
			};

			if (method.name === "initialize") {
				cls.initializeMethod = method;
			} else {
				cls.instanceMethods.push(method);
			}

			continue;
		}

		//
		// get foo() {}
		//
		if (ts.isGetAccessorDeclaration(member)) {
			cls.instanceMethods.push({
				name: member.name.getText(),
				isStatic: false,
				parameters: [],
				body: member.body ?? ts.factory.createBlock([], true),
				sourceStatement: statement,
				sourceNode: member,
			});

			continue;
		}

		//
		// set foo(v) {}
		//
		if (ts.isSetAccessorDeclaration(member)) {
			cls.instanceMethods.push({
				name: member.name.getText(),
				isStatic: false,
				parameters: member.parameters,
				body: member.body ?? ts.factory.createBlock([], true),
				sourceStatement: statement,
				sourceNode: member,
			});

			continue;
		}

		//
		// foo: "bar"
		// foo: 123
		// type: "MyClass"
		//
		if (ts.isPropertyAssignment(member)) {
			const name = ts.isIdentifier(member.name) ? member.name.text : member.name.getText();

			cls.properties.push({
				name,
				isStatic: false,
				isReadonly: name === "type" || isStaticConstant(name, member.initializer),
				initializer: member.initializer,
				sourceStatement: statement,
				sourceNode: member,
			});

			continue;
		}

		//
		// { foo }
		//
		if (ts.isShorthandPropertyAssignment(member)) {
			cls.properties.push({
				name: member.name.text,
				isStatic: false,
				initializer: ts.factory.createIdentifier(member.name.text),
				sourceStatement: statement,
				sourceNode: member,
			});
		}
	}
}

function detectPrototypeMethod(statement: ts.Statement, assignment: ts.BinaryExpression, classes: Map<string, ClassInfo>): void {
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

	const cls = classes.get(proto.expression.text);

	if (!cls) {
		return;
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

function detectStaticProperty(statement: ts.Statement, assignment: ts.BinaryExpression, classes: Map<string, ClassInfo>): void {
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

	const cls = classes.get(lhs.expression.text);

	if (!cls) {
		return;
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

function detectStaticMethod(statement: ts.Statement, assignment: ts.BinaryExpression, classes: Map<string, ClassInfo>): void {
	if (!ts.isPropertyAccessExpression(assignment.left)) {
		return;
	}

	if (assignment.left.name.text === "prototype") {
		return;
	}

	if (!ts.isIdentifier(assignment.left.expression) || !ts.isFunctionExpression(assignment.right)) {
		return;
	}

	const cls = classes.get(assignment.left.expression.text);

	if (!cls) {
		return;
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
``;

function detectPrototypeObjectLiteral(statement: ts.Statement, assignment: ts.BinaryExpression, classes: Map<string, ClassInfo>): void {
	if (!ts.isPropertyAccessExpression(assignment.left) || !ts.isIdentifier(assignment.left.expression) || assignment.left.name.text !== "prototype") {
		return;
	}

	const cls = classes.get(assignment.left.expression.text);

	if (!cls) {
		return;
	}

	if (!ts.isObjectLiteralExpression(assignment.right)) {
		return;
	}

	processPrototypeObjectLiteral(cls, statement, assignment.right);

	cls.consumedStatements.add(statement);
}

export const prototypeToClassTransformFactory: (program: ts.Program) => ts.TransformerFactory<ts.SourceFile> = (program) => (context) => (sourceFile) => {
	const { factory } = context;

	function visit(node: ts.Node): ts.Node {
		if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
			const transformed = transformScope(sourceFile, node, factory);

			return ts.visitEachChild(transformed, visit, context);
		}

		return ts.visitEachChild(node, visit, context);
	}

	return ts.visitNode(sourceFile, visit) as ts.SourceFile;
};

function looksLikePrototypeObject(obj: ts.ObjectLiteralExpression): boolean {
	for (const property of obj.properties) {
		if (ts.isPropertyAssignment(property) && ts.isFunctionExpression(property.initializer)) {
			return true;
		}

		if (ts.isMethodDeclaration(property)) {
			return true;
		}
	}

	return false;
}

function discoverClassesInStatements(statements: readonly ts.Statement[]): Map<string, ClassInfo> {
	const classes = new Map<string, ClassInfo>();

	//
	// Class.create()
	//
	for (const stmt of statements) {
		detectClassCreate(stmt, classes);
	}

	for (const stmt of statements) {
		if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			classes.set(stmt.name.text, {
				name: stmt.name.text,
				ctor: stmt,
				instanceMethods: [],
				staticMethods: [],
				properties: [],
				consumedStatements: new Set([stmt]),
			});
		}
	}

	for (const stmt of statements) {
		if (!ts.isExpressionStatement(stmt) || !ts.isBinaryExpression(stmt.expression)) {
			continue;
		}

		const assignment = stmt.expression;

		detectInheritance(assignment, classes);

		detectExtendsObject(stmt, assignment, classes);

		detectPrototypeObjectLiteral(stmt, assignment, classes);

		detectPrototypeMethod(stmt, assignment, classes);

		detectPrototypeProperty(stmt, assignment, classes);

		detectStaticMethod(stmt, assignment, classes);

		detectStaticProperty(stmt, assignment, classes);
	}

	return classes;
}

function emitStatements(sourceFile: ts.SourceFile, statements: readonly ts.Statement[], classes: Map<string, ClassInfo>, factory: ts.NodeFactory): ts.Statement[] {
	const output: ts.Statement[] = [];

	const consumedStatements = new Set<ts.Statement>();

	for (const cls of classes.values()) {
		for (const stmt of cls.consumedStatements) {
			consumedStatements.add(stmt);
		}
	}

	const emittedClasses = new Set<string>();

	for (const statement of statements) {
		if (ts.isVariableStatement(statement)) {
			for (const decl of statement.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) {
					const cls = classes.get(decl.name.text);

					if (cls && cls.classCreateStatement === statement) {
						output.push(emitClass(sourceFile, cls, factory));

						emittedClasses.add(cls.name);

						continue;
					}
				}
			}
		}
		if (ts.isFunctionDeclaration(statement) && statement.name) {
			const cls = classes.get(statement.name.text);

			if (cls && !emittedClasses.has(cls.name)) {
				output.push(emitClass(sourceFile, cls, factory));

				emittedClasses.add(cls.name);

				continue;
			}
		}

		if (consumedStatements.has(statement)) {
			continue;
		}

		output.push(statement);
	}

	return output;
}

function isBlockLike<T extends ts.Node>(node: T): node is ts.BlockLike & T {
	return ts.isBlockLike(node);
}

function transformScope<T extends ts.Node>(sourceFile: ts.SourceFile, scope: T, factory: ts.NodeFactory): T {
	if (!isBlockLike(scope)) return scope;

	const statements = scope.statements;

	const classes = discoverClassesInStatements(statements);

	if (classes.size === 0) {
		return scope;
	}

	const newStatements = emitStatements(sourceFile, statements, classes, factory);

	if (ts.isSourceFile(scope)) {
		return factory.updateSourceFile(scope, newStatements) as unknown as T;
	}

	if (ts.isBlock(scope)) {
		return factory.updateBlock(scope, newStatements) as unknown as T;
	}

	if (ts.isModuleBlock(scope)) {
		return factory.updateModuleBlock(scope, newStatements) as unknown as T;
	}

	return scope;
}

export default ({program}: {program: ts.Program}) => prototypeToClassTransformFactory(program);
