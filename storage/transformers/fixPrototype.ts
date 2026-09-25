import ts from "typescript";

interface MethodInfo {
	name: string;
	isStatic: boolean;
	parameters: readonly ts.ParameterDeclaration[];
	body: ts.Block;
	sourceNode: ts.Node;
}

interface PropertyInfo {
	name: string;
	isStatic: boolean;
	isReadonly?: boolean;
	initializer?: ts.Expression;
	sourceNode: ts.Node;
}

interface ClassInfo {
	name: string;
	root: ts.Statement;
	definingScope: ScopeContext;
	targetScope?: ScopeContext;
	classCreate?: ts.VariableStatement;
	ctor?: ts.FunctionDeclaration;
	initialize?: MethodInfo;
	baseClass?: string;
	methods: MethodInfo[];
	staticMethods: MethodInfo[];
	properties: PropertyInfo[];
	consumed: Set<ts.Statement>;
}

interface ScopeContext {
	parent?: ScopeContext;
	node: ts.SourceFile | ts.Block | ts.ModuleBlock;
	classes: Map<string, ClassInfo>;
	childScopes: Map<ts.Node, ScopeContext>;
}

const validProperty = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isObjectInheritance(name: string) {
	return name === "extendsObject" || name === "extend";
}

function memberName(node: ts.PropertyName) {
	return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : node.getText();
}

function isStaticConstant(name: string, value: ts.Expression) {
	return name.toUpperCase() === name || ts.isStringLiteral(value) || ts.isNumericLiteral(value);
}

function resolveClass(scope: ScopeContext, name: string) {
	let current: ScopeContext | undefined = scope;
	while (current) {
		const cls = current.classes.get(name);
		if (cls) return cls;
		current = current.parent;
	}
	return undefined;
}

function markTargetScope(cls: ClassInfo, scope: ScopeContext) {
	if (cls.definingScope !== scope) cls.targetScope = scope;
}

function detectClassCreate(statement: ts.Statement, scope: ScopeContext) {
	if (!ts.isVariableStatement(statement)) return;
	for (const declaration of statement.declarationList.declarations) {
		if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
		const call = declaration.initializer;
		if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression)) continue;
		if (call.expression.expression.text !== "Class" || call.expression.name.text !== "create") continue;
		scope.classes.set(declaration.name.text, {
			name: declaration.name.text,
			root: statement,
			definingScope: scope,
			classCreate: statement,
			methods: [],
			staticMethods: [],
			properties: [],
			consumed: new Set([statement]),
		});
	}
}

function detectFunctionRoots(statement: ts.Statement, scope: ScopeContext) {
	if (!ts.isFunctionDeclaration(statement) || !statement.name) return;
	scope.classes.set(statement.name.text, {
		name: statement.name.text,
		root: statement,
		definingScope: scope,
		ctor: statement,
		methods: [],
		staticMethods: [],
		properties: [],
		consumed: new Set([statement]),
	});
}

function setInheritance(assignment: ts.BinaryExpression, cls: ClassInfo) {
	if (!ts.isCallExpression(assignment.right) || !ts.isPropertyAccessExpression(assignment.right.expression)) return;
	const call = assignment.right;
	const target = call.expression;
	if (!ts.isPropertyAccessExpression(target)) return;
	if (!ts.isIdentifier(target.expression) || target.expression.text !== "Object") return;
	if (target.name.text === "create" && call.arguments.length === 1) {
		const parent = call.arguments[0];
		if (parent && ts.isPropertyAccessExpression(parent) && parent.name.text === "prototype" && ts.isIdentifier(parent.expression)) cls.baseClass = parent.expression.text;
	}
	if (isObjectInheritance(target.name.text) && call.arguments.length >= 1) {
		const parent = call.arguments[0];
		if (parent && (ts.isIdentifier(parent) || ts.isPropertyAccessExpression(parent))) cls.baseClass = parent.getText();
	}
}

function addMethod(cls: ClassInfo, method: MethodInfo) {
	if (method.name === "initialize" && !method.isStatic) cls.initialize = method;
	else if (method.isStatic) cls.staticMethods.push(method);
	else cls.methods.push(method);
}

function addPrototypeObject(cls: ClassInfo, statement: ts.Statement, object: ts.ObjectLiteralExpression) {
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) continue;
		if (ts.isPropertyAssignment(property) && (ts.isFunctionExpression(property.initializer) || ts.isArrowFunction(property.initializer))) {
			const fn = property.initializer;
			const body = ts.isBlock(fn.body) ? fn.body : ts.factory.createBlock([ts.factory.createReturnStatement(fn.body)], true);
			addMethod(cls, { name: memberName(property.name), isStatic: false, parameters: fn.parameters, body, sourceNode: property });
			continue;
		}
		if (ts.isMethodDeclaration(property)) {
			addMethod(cls, { name: memberName(property.name), isStatic: false, parameters: property.parameters, body: property.body || ts.factory.createBlock([], true), sourceNode: property });
			continue;
		}
		if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
			addMethod(cls, {
				name: memberName(property.name),
				isStatic: false,
				parameters: ts.isSetAccessorDeclaration(property) ? property.parameters : [],
				body: property.body || ts.factory.createBlock([], true),
				sourceNode: property,
			});
			continue;
		}
		if (ts.isPropertyAssignment(property) && ts.isMemberName(property.name)) {
			const name = memberName(property.name);
			cls.properties.push({ name, isStatic: false, isReadonly: name === "type" || isStaticConstant(name, property.initializer), initializer: property.initializer, sourceNode: property });
			continue;
		}
		if (ts.isShorthandPropertyAssignment(property)) {
			cls.properties.push({ name: property.name.text, isStatic: false, initializer: ts.factory.createIdentifier(property.name.text), sourceNode: property });
		}
	}
	void statement;
}

function detectAssignment(statement: ts.Statement, assignment: ts.BinaryExpression, scope: ScopeContext) {
	if (!ts.isPropertyAccessExpression(assignment.left)) return;
	const left = assignment.left;
	const className = ts.isIdentifier(left.expression) ? left.expression.text : undefined;
	if (!className) return;
	const cls = resolveClass(scope, className);
	if (!cls) return;
	markTargetScope(cls, scope);

	if (left.name.text === "prototype") {
		if (ts.isObjectLiteralExpression(assignment.right)) {
			addPrototypeObject(cls, statement, assignment.right);
			cls.consumed.add(statement);
			return;
		}
		setInheritance(assignment, cls);
		if (ts.isCallExpression(assignment.right) && ts.isPropertyAccessExpression(assignment.right.expression) && isObjectInheritance(assignment.right.expression.name.text)) {
			const members = assignment.right.arguments[1];
			if (members && ts.isObjectLiteralExpression(members)) addPrototypeObject(cls, statement, members);
			cls.consumed.add(statement);
		}
		return;
	}

	if (ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === "prototype") {
		const value = assignment.right;
		if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
			const body = ts.isBlock(value.body) ? value.body : ts.factory.createBlock([ts.factory.createReturnStatement(value.body)], true);
			addMethod(cls, { name: left.name.text, isStatic: false, parameters: value.parameters, body, sourceNode: statement });
		} else {
			cls.properties.push({ name: left.name.text, isStatic: false, isReadonly: left.name.text === "type", initializer: value, sourceNode: statement });
		}
		cls.consumed.add(statement);
		return;
	}

	if (ts.isFunctionExpression(assignment.right) || ts.isArrowFunction(assignment.right)) {
		const fn = assignment.right;
		const body = ts.isBlock(fn.body) ? fn.body : ts.factory.createBlock([ts.factory.createReturnStatement(fn.body)], true);
		addMethod(cls, { name: left.name.text, isStatic: true, parameters: fn.parameters, body, sourceNode: statement });
	} else {
		cls.properties.push({ name: left.name.text, isStatic: true, isReadonly: isStaticConstant(left.name.text, assignment.right), initializer: assignment.right, sourceNode: statement });
	}
	cls.consumed.add(statement);
}

function discover(scope: ScopeContext) {
	scope.node.statements.forEach((statement) => detectClassCreate(statement, scope));
	scope.node.statements.forEach((statement) => detectFunctionRoots(statement, scope));
	scope.node.statements.forEach((statement) => {
		if (ts.isExpressionStatement(statement)) visitAssignment(statement, statement.expression, scope);
	});
}

function visitAssignment(statement: ts.Statement, expression: ts.Expression, scope: ScopeContext) {
	if (!ts.isBinaryExpression(expression)) return;
	if (expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
		visitAssignment(statement, expression.left, scope);
		visitAssignment(statement, expression.right, scope);
		return;
	}
	if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) detectAssignment(statement, expression, scope);
}

function processScope(node: ts.SourceFile | ts.Block | ts.ModuleBlock, scope: ScopeContext) {
	discover(scope);
	for (const statement of node.statements) {
		const visit = (child: ts.Node): void => {
			if (ts.isBlock(child) || ts.isModuleBlock(child)) {
				const childScope: ScopeContext = { parent: scope, node: child, classes: new Map(), childScopes: new Map() };
				scope.childScopes.set(child, childScope);
				processScope(child, childScope);
				return;
			}
			ts.forEachChild(child, visit);
		};
		visit(statement);
	}
}

function emitMethod(method: MethodInfo, factory: ts.NodeFactory) {
	return factory.createMethodDeclaration(method.isStatic ? [factory.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined, undefined, method.name, undefined, undefined, method.parameters, undefined, method.body);
}

function emitClass(cls: ClassInfo, factory: ts.NodeFactory) {
	const members: ts.ClassElement[] = [];
	const constructorStatements: ts.Statement[] = [];
	const parameters = cls.initialize?.parameters || [];
	if (cls.classCreate) constructorStatements.push(factory.createExpressionStatement(factory.createBinaryExpression(factory.createPropertyAccessExpression(factory.createThis(), "type"), factory.createToken(ts.SyntaxKind.EqualsToken), factory.createStringLiteral(cls.name))));
	if (cls.ctor?.body) constructorStatements.push(...cls.ctor.body.statements);
	if (cls.initialize?.body) constructorStatements.push(...cls.initialize.body.statements);
	if (parameters.length || constructorStatements.length) members.push(factory.createConstructorDeclaration(undefined, parameters, factory.createBlock(constructorStatements, true)));
	members.push(...cls.staticMethods.map((method) => emitMethod(method, factory)));
	for (const property of cls.properties) {
		let initializer = property.initializer;
		if (property.isReadonly && initializer && !ts.isInJSFile(initializer)) initializer = factory.createAsExpression(initializer, factory.createTypeReferenceNode("const"));
		members.push(factory.createPropertyDeclaration(property.isStatic ? [factory.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined, property.name, undefined, undefined, initializer));
	}
	members.push(...cls.methods.map((method) => emitMethod(method, factory)));
	const heritage = cls.baseClass ? [factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [factory.createExpressionWithTypeArguments(factory.createIdentifier(cls.baseClass), undefined)])] : undefined;
	return factory.createClassDeclaration(undefined, cls.name, undefined, heritage, members);
}

function isConvertibleClass(cls: ClassInfo) {
	return !!cls.classCreate || cls.targetScope !== undefined || cls.baseClass !== undefined || cls.initialize !== undefined || cls.methods.length > 0 || cls.staticMethods.length > 0 || cls.properties.length > 0;
}

function getClassesTargetingScope(scope: ScopeContext) {
	const classes: ClassInfo[] = [];
	let current = scope.parent;
	while (current) {
		for (const cls of current.classes.values()) {
			if (cls.targetScope === scope && isConvertibleClass(cls)) classes.push(cls);
		}
		current = current.parent;
	}
	return classes;
}

function isPrototypeFreeze(statement: ts.Statement, scope: ScopeContext) {
	if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
	const call = statement.expression;
	if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== "Object" || call.expression.name.text !== "freeze") return false;
	const argument = call.arguments[0];
	if (!argument || !ts.isPropertyAccessExpression(argument) || argument.name.text !== "prototype" || !ts.isIdentifier(argument.expression)) return false;
	return resolveClass(scope, argument.expression.text)?.targetScope !== undefined;
}

function rewriteIifeForClasses(statement: ts.Statement, scope: ScopeContext, factory: ts.NodeFactory): ts.Statement {
	if (!ts.isExpressionStatement(statement)) return statement;
	const expression = statement.expression;
	const call = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
	if (!ts.isCallExpression(call) || !ts.isFunctionExpression(call.expression)) return statement;
	const childScope = scope.childScopes.get(call.expression.body);
	if (!childScope || getClassesTargetingScope(childScope).length === 0) return statement;
	const rewrittenBody = transformScope(call.expression.body, childScope, factory);
	const rewrittenFunction = factory.updateFunctionExpression(
		call.expression,
		call.expression.modifiers,
		call.expression.asteriskToken,
		call.expression.name,
		call.expression.typeParameters,
		call.expression.parameters,
		call.expression.type,
		rewrittenBody,
	);
	const rewrittenCall = factory.updateCallExpression(call, rewrittenFunction, call.typeArguments, call.arguments);
	const initializer = ts.isParenthesizedExpression(expression) ? factory.updateParenthesizedExpression(expression, rewrittenCall) : rewrittenCall;
	const targetClass = getClassesTargetingScope(childScope)[0]!;
	return factory.createVariableStatement(
		undefined,
		factory.createVariableDeclarationList([factory.createVariableDeclaration(factory.createIdentifier(targetClass.name), undefined, undefined, initializer)], ts.NodeFlags.None),
	);
}

function transformScope<T extends ts.Node>(scope: T, scopeContext: ScopeContext, factory: ts.NodeFactory): T {
	if (!(ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope))) return scope;
	const consumed = new Set<ts.Statement>();
	scopeContext.classes.forEach((cls) => {
		if (isConvertibleClass(cls)) cls.consumed.forEach((statement) => consumed.add(statement));
	});
	getClassesTargetingScope(scopeContext).forEach((cls) => cls.consumed.forEach((statement) => consumed.add(statement)));
	const output: ts.Statement[] = [];
	const emitted = new Set<string>();
	for (const statement of scope.statements) {
		const className = ts.isVariableStatement(statement) ? statement.declarationList.declarations.find((declaration) => ts.isIdentifier(declaration.name) && scopeContext.classes.has(declaration.name.text)) : undefined;
		const classInfo = className && ts.isIdentifier(className.name) ? scopeContext.classes.get(className.name.text) : ts.isFunctionDeclaration(statement) && statement.name ? scopeContext.classes.get(statement.name.text) : undefined;
		if (classInfo && !emitted.has(classInfo.name)) {
			if (!classInfo.targetScope && isConvertibleClass(classInfo)) output.push(emitClass(classInfo, factory));
			emitted.add(classInfo.name);
		} else if (!consumed.has(statement) && !isPrototypeFreeze(statement, scopeContext)) output.push(rewriteIifeForClasses(statement, scopeContext, factory));
	}
	for (const cls of getClassesTargetingScope(scopeContext).reverse()) output.unshift(emitClass(cls, factory));
	for (const cls of getClassesTargetingScope(scopeContext)) output.push(factory.createReturnStatement(factory.createIdentifier(cls.name)));
	if (ts.isSourceFile(scope)) return factory.updateSourceFile(scope, output) as unknown as T;
	if (ts.isBlock(scope)) return factory.updateBlock(scope, output) as unknown as T;
	return factory.updateModuleBlock(scope, output) as unknown as T;
}

export const fixPrototypeTransformer: (program: ts.Program) => ts.TransformerFactory<ts.SourceFile> = (program) => (context) => {
	return (sourceFile) => {
		if (!ts.isSourceFile(sourceFile))
			throw new Error("sourceFile is not ts.SourceFile", sourceFile)
		const rootScope: ScopeContext = { node: sourceFile, classes: new Map(), childScopes: new Map() };
		processScope(sourceFile, rootScope);
		console.dir(rootScope);
		return transformScope(sourceFile, rootScope, context.factory);
	};
};

export default  ({program}: {program: ts.Program}) => fixPrototypeTransformer(program);