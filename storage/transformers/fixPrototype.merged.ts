import ts from "typescript";

type ScopeNode = ts.SourceFile | ts.Block | ts.ModuleBlock;
type ConstructorFunction = ts.FunctionDeclaration | ts.FunctionExpression;
type MethodKind = "method" | "get" | "set";
type DiagnosticCode = "AMBIGUOUS_IIFE_CLASS" | "DUPLICATE_CLASS_ROOT" | "MISSING_SUPER_CALL" | "UNSAFE_ARROW_FUNCTION" | "UNSAFE_INITIALIZE_MERGE";

export interface TransformDiagnostic {
	code: DiagnosticCode;
	message: string;
	node: ts.Node;
	className?: string;
}
export type FixPrototypeLogLevel = "debug" | "info" | "warn";
export interface FixPrototypeLogEntry {
	level: FixPrototypeLogLevel;
	event: string;
	message: string;
	fileName?: string;
	scopeKind?: ts.SyntaxKind;
	className?: string;
	node?: ts.Node;
	data?: Record<string, unknown>;
}
export type NamespaceClassStrategy = "hoist" | "inline-static" | "preserve";
export interface FixPrototypeTransformerOptions {
	onDiagnostic?: (diagnostic: TransformDiagnostic) => void;
	debug?: boolean;
	logger?: (entry: FixPrototypeLogEntry) => void;
	checker?: ts.TypeChecker;
	namespaceClassStrategy?: NamespaceClassStrategy;
}

interface ClassTarget {
	key: string;
	name: string;
	assignmentTarget?: ts.Expression;
}
interface MethodInfo {
	name: ts.PropertyName;
	kind: MethodKind;
	isStatic: boolean;
	parameters: readonly ts.ParameterDeclaration[];
	body: ts.Block;
	sourceStatement: ts.Statement;
	sourceNode: ts.Node;
	localFunction?: ts.FunctionDeclaration;
}
interface PropertyInfo {
	name: ts.PropertyName;
	isStatic: boolean;
	constLike: boolean;
	initializer?: ts.Expression;
	sourceStatement: ts.Statement;
	sourceNode: ts.Node;
}
type MemberInfo = MethodInfo | PropertyInfo;
interface ClassInfo {
	target: ClassTarget;
	root: ts.Statement;
	definingScope: ScopeContext;
	targetScopes: Set<ScopeContext>;

	existingClass?: ts.ClassDeclaration;

	/**
	 * Existing class fields replaced by promoted methods.
	 *
	 * Example:
	 *
	 * static getRecord = getRecord;
	 */
	replacedExistingMembers:
	Set<ts.ClassElement>;

	classCreateStatement?: ts.VariableStatement;
	constructorFunction?: ConstructorFunction;
	initializeMethod?: MethodInfo;
	baseClass?: ts.Expression;
	es5SuperParameter?: ts.Identifier;
	es5SuperExpression?: ts.Expression;
	es5HelperStatements: Set<ts.Statement>;
	members: MemberInfo[];
	consumedStatements: Set<ts.Statement>;
	preClassStatements: ts.Statement[];
	postClassStatements: ts.Statement[];
	hoistedIntoOwner?: ClassInfo;
	hoistedName?: string;
	convertible: boolean;
}
interface ScopeContext {
	parent?: ScopeContext;
	node: ScopeNode;
	classes: Map<string, ClassInfo>;
	childScopes: Map<ScopeNode, ScopeContext>;
	resolveParentClasses: boolean;
}
interface ClassFactoryIife {
	statement: ts.VariableStatement;
	declaration: ts.VariableDeclaration;
	callExpression: ts.CallExpression;
	calleeExpression: ts.Expression;
	functionExpression: ts.FunctionExpression;
	childScope: ScopeContext;
	returnedClass: ClassInfo;
}
interface PromotedFunction {
	methodName: string;
	declaration: ts.FunctionDeclaration;
	symbol?: ts.Symbol;
}

function log(o: FixPrototypeTransformerOptions, e: FixPrototypeLogEntry): void {
	if (!o.debug && !o.logger) return;
	if (o.logger) return o.logger(e);
	const d = e.data ? ` ${JSON.stringify(e.data)}` : "";
	(e.level === "warn" ? console.warn
		: e.level === "debug" ? console.debug
			: console.info)(`[fixPrototype:${e.event}] ${e.message}${d}`);
}
function report(o: FixPrototypeTransformerOptions, d: TransformDiagnostic): void {
	o.onDiagnostic?.(d);
	log(o, { level: "warn", event: "diagnostic", message: d.message, className: d.className, node: d.node, data: { code: d.code } });
}
function nodeLocation(sf: ts.SourceFile, n: ts.Node): Record<string, unknown> {
	const p = sf.getLineAndCharacterOfPosition(n.getStart(sf, false));
	return { line: p.line + 1, column: p.character + 1, kind: ts.SyntaxKind[n.kind] };
}
function createScope(node: ScopeNode, parent?: ScopeContext, resolveParentClasses = true): ScopeContext {
	return { parent, node, classes: new Map(), childScopes: new Map(), resolveParentClasses };
}
function unwrap(e: ts.Expression): ts.Expression {
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	return e;
}
function expressionPath(e: ts.Expression): string | undefined {
	if (ts.isIdentifier(e)) return e.text;
	if (ts.isPropertyAccessExpression(e)) {
		const l = expressionPath(e.expression);
		return l ? `${l}.${e.name.text}` : undefined;
	}
	if (ts.isElementAccessExpression(e) && ts.isStringLiteral(e.argumentExpression)) {
		const l = expressionPath(e.expression);
		return l ? `${l}.${e.argumentExpression.text}` : undefined;
	}
	return undefined;
}
function targetName(e: ts.Expression): string | undefined {
	return (
		ts.isIdentifier(e) ? e.text
			: ts.isPropertyAccessExpression(e) ? e.name.text
				: ts.isElementAccessExpression(e) && ts.isStringLiteral(e.argumentExpression) ? e.argumentExpression.text
					: undefined
	);
}
function createClassInfo(
	target: ClassTarget,
	root: ts.Statement,
	scope: ScopeContext,
): ClassInfo {
	return {
		target,
		root,
		definingScope: scope,
		targetScopes: new Set(),
		replacedExistingMembers:
			new Set<ts.ClassElement>(),
		es5HelperStatements: new Set<ts.Statement>(),
		members: [],

		consumedStatements:
			ts.isClassDeclaration(root)
				? new Set<ts.Statement>()
				: new Set<ts.Statement>([root]),

		preClassStatements: [],
		postClassStatements: [],
		convertible: true,
	};
}

function hasStaticModifier(
	member: ts.ClassElement,
): boolean {

	return ts.canHaveModifiers(member) && member.modifiers?.some(
		modifier =>
			modifier.kind ===
			ts.SyntaxKind.StaticKeyword,
	) === true;
}

function promoteExistingClassAliases(
	cls: ClassInfo,
	scope: ScopeContext,
	options: FixPrototypeTransformerOptions,
): void {
	const existingClass =
		cls.existingClass;

	if (!existingClass) {
		return;
	}

	for (
		const member
		of existingClass.members
	) {
		/*
		 * Recognize:
		 *
		 * static getRecord = getRecord;
		 */
		if (
			!ts.isPropertyDeclaration(member) ||
			!hasStaticModifier(member) ||
			!member.initializer ||
			!ts.isIdentifier(member.initializer)
		) {
			continue;
		}

		const memberName =
			member.name;

		const localIdentifier =
			member.initializer;

		const functionDeclaration =
			findFunctionDeclaration(
				scope,
				localIdentifier.text,
			);

		if (!functionDeclaration?.body) {
			continue;
		}

		const functionCandidate =
			scope.classes.get(
				localIdentifier.text,
			);

		/*
		 * If the function has actual class evidence, do not
		 * repurpose it as a static method.
		 */
		if (
			functionCandidate &&
			functionCandidate.root ===
			functionDeclaration &&
			hasClassEvidence(
				functionCandidate,
			)
		) {
			continue;
		}

		addMethod(cls, {
			name: memberName,
			kind: "method",
			isStatic: true,
			parameters:
				functionDeclaration.parameters,
			body:
				functionDeclaration.body,

			/*
			 * The class declaration is the containing
			 * statement for this promotion.
			 */
			sourceStatement:
				existingClass,

			sourceNode:
				functionDeclaration,

			localFunction:
				functionDeclaration,
		});

		cls.replacedExistingMembers.add(
			member,
		);

		cls.consumedStatements.add(
			functionDeclaration,
		);

		/*
		 * Remove the provisional helper-function candidate,
		 * otherwise transformScope() preserves it separately.
		 */
		if (
			functionCandidate?.root ===
			functionDeclaration
		) {
			scope.classes.delete(
				localIdentifier.text,
			);
		}

		log(options, {
			level: "info",
			event:
				"function.promote-class-field",

			message:
				`Promoted local function ` +
				`${localIdentifier.text} to static method ` +
				`${cls.target.key}.` +
				`${propertyText(memberName) ??
				localIdentifier.text}.`,

			className:
				cls.target.key,

			node:
				functionDeclaration,

			data: {
				localFunction:
					localIdentifier.text,

				staticMethod:
					propertyText(memberName) ??
					localIdentifier.text,
			},
		});
	}
}

function registerClass(scope: ScopeContext, cls: ClassInfo, o: FixPrototypeTransformerOptions): ClassInfo {
	const old = scope.classes.get(cls.target.key);
	if (!old) {
		scope.classes.set(cls.target.key, cls);
		log(o, {
			level: "debug",
			event: "class.register",
			message: `Registered class candidate ${cls.target.key}.`,
			className: cls.target.key,
			node: cls.root,
			data: { qualified: !!cls.target.assignmentTarget, existingClass: !!cls.existingClass, rootKind: ts.SyntaxKind[cls.root.kind] },
		});
		return cls;
	}
	if (old.root === cls.root) return old;
	old.convertible = false;
	report(o, { code: "DUPLICATE_CLASS_ROOT", message: `Multiple class roots named ${cls.target.key}.`, node: cls.root, className: cls.target.key });
	return old;
}
function resolveClass(scope: ScopeContext, key: string): ClassInfo | undefined {
	let cur: ScopeContext | undefined = scope,
		allow = true;
	while (cur) {
		const c = cur.classes.get(key);
		if (c) return c;
		allow = allow && cur.resolveParentClasses;
		if (!allow) return;
		cur = cur.parent;
	}
	return;
}
function isClassCreate(e: ts.Expression): boolean {
	e = unwrap(e);
	return (
		ts.isCallExpression(e) &&
		ts.isPropertyAccessExpression(e.expression) &&
		ts.isIdentifier(e.expression.expression) &&
		e.expression.expression.text === "Class" &&
		e.expression.name.text === "create"
	);
}
function detectDeclarationRoots(s: ts.Statement, scope: ScopeContext, o: FixPrototypeTransformerOptions): void {
	if (ts.isClassDeclaration(s) && s.name) {
		const c = createClassInfo({ key: s.name.text, name: s.name.text }, s, scope);
		c.existingClass = s;
		registerClass(scope, c, o);
		return;
	}
	if (ts.isFunctionDeclaration(s) && s.name) {
		const c = createClassInfo({ key: s.name.text, name: s.name.text }, s, scope);
		c.constructorFunction = s;
		registerClass(scope, c, o);
		return;
	}
	if (!ts.isVariableStatement(s)) return;
	for (const d of s.declarationList.declarations) {
		if (!ts.isIdentifier(d.name) || !d.initializer) continue;
		const n = d.name.text,
			i = unwrap(d.initializer);
		if (isClassCreate(i)) {
			const c = createClassInfo({ key: n, name: n }, s, scope);
			c.classCreateStatement = s;
			registerClass(scope, c, o);
		} else if (ts.isFunctionExpression(i)) {
			const c = createClassInfo({ key: n, name: n }, s, scope);
			c.constructorFunction = i;
			registerClass(scope, c, o);
		}
	}
}
function prototypeOwner(e: ts.Expression): ts.Expression | undefined {
	return (
		ts.isPropertyAccessExpression(e) && e.name.text === "prototype" ? e.expression
			: ts.isElementAccessExpression(e) && ts.isStringLiteral(e.argumentExpression) && e.argumentExpression.text === "prototype" ? e.expression
				: undefined
	);
}
function parsePrototypeLeft(e: ts.Expression): { key: string; member?: ts.Expression } | undefined {
	const direct = prototypeOwner(e);
	if (direct) {
		const key = expressionPath(direct);
		return key ? { key } : undefined;
	}
	if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
		const owner = prototypeOwner(e.expression),
			key = owner && expressionPath(owner);
		return key ? { key, member: e } : undefined;
	}
	return;
}
function assignmentFromStatement(s: ts.Statement): ts.BinaryExpression | undefined {
	return ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken ? s.expression : undefined;
}
function scopeUsesPrototype(scope: ScopeContext, key: string): boolean {
	for (const s of scope.node.statements) {
		if (!ts.isExpressionStatement(s)) continue;
		let found = false;
		const visit = (e: ts.Expression): void => {
			if (found || !ts.isBinaryExpression(e)) return;
			if (e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
				visit(e.left);
				visit(e.right);
			} else if (e.operatorToken.kind === ts.SyntaxKind.EqualsToken && parsePrototypeLeft(e.left)?.key === key) found = true;
		};
		visit(s.expression);
		if (found) return true;
	}
	return false;
}
function detectQualifiedRoots(s: ts.Statement, scope: ScopeContext, o: FixPrototypeTransformerOptions): void {
	const a = assignmentFromStatement(s);
	if (!a) return;
	const r = unwrap(a.right);
	if (!ts.isFunctionExpression(r) || ts.isIdentifier(a.left)) return;
	const key = expressionPath(a.left),
		name = targetName(a.left);
	if (!key || !name || !key.includes(".") || key.split(".").includes("prototype") || !scopeUsesPrototype(scope, key)) return;
	const c = createClassInfo({ key, name, assignmentTarget: a.left }, s, scope);
	c.constructorFunction = r;
	registerClass(scope, c, o);
}
function detectQualifiedClassFactoryRoot(
	statement: ts.Statement,
	scope: ScopeContext,
	options: FixPrototypeTransformerOptions,
): void {
	const assignment = assignmentFromStatement(statement);
	if (!assignment || ts.isIdentifier(assignment.left)) return;
	const key = expressionPath(assignment.left);
	const name = targetName(assignment.left);
	if (!key || !name || !key.includes(".") || key.split(".").includes("prototype")) return;
	const call = unwrap(assignment.right);
	if (!ts.isCallExpression(call)) return;
	const fn = unwrap(call.expression);
	if (!ts.isFunctionExpression(fn)) return;
	let returned: ts.Identifier | undefined;
	for (let index = fn.body.statements.length - 1; index >= 0; index--) {
		const candidate = fn.body.statements[index]!;
		if (ts.isEmptyStatement(candidate)) continue;
		if (ts.isReturnStatement(candidate) && candidate.expression && ts.isIdentifier(candidate.expression)) returned = candidate.expression;
		break;
	}
	if (!returned || returned.text !== name) return;
	const constructor = fn.body.statements.find((candidate): candidate is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(candidate) && candidate.name?.text === name && !!candidate.body,
	);
	if (!constructor) return;
	const cls = createClassInfo({ key, name, assignmentTarget: assignment.left }, statement, scope);
	cls.constructorFunction = constructor;
	registerClass(scope, cls, options);
}

function cloneName(n: ts.PropertyName, f: ts.NodeFactory): ts.PropertyName {
	if (ts.isIdentifier(n)) return f.createIdentifier(n.text);
	if (ts.isPrivateIdentifier(n)) return f.createPrivateIdentifier(n.text);
	if (ts.isStringLiteral(n)) return f.createStringLiteral(n.text);
	if (ts.isNumericLiteral(n)) return f.createNumericLiteral(n.text);
	if (ts.isBigIntLiteral(n)) return f.createBigIntLiteral(n.text);
	if (ts.isComputedPropertyName(n)) return f.createComputedPropertyName(n.expression);
	return f.createStringLiteral(n.text);
}
function nameFromAccess(e: ts.Expression, f: ts.NodeFactory): ts.PropertyName | undefined {
	if (ts.isPropertyAccessExpression(e)) return f.createIdentifier(e.name.text);
	if (!ts.isElementAccessExpression(e) || !e.argumentExpression) return;
	const a = e.argumentExpression;
	return (
		ts.isStringLiteral(a) ? f.createStringLiteral(a.text)
			: ts.isNumericLiteral(a) ? f.createNumericLiteral(a.text)
				: f.createComputedPropertyName(a)
	);
}
function propertyText(n: ts.PropertyName): string | undefined {
	return ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : undefined;
}
function isMethod(m: MemberInfo): m is MethodInfo {
	return "kind" in m;
}
function addMethod(c: ClassInfo, m: MethodInfo): void {
	if (!m.isStatic && m.kind === "method" && propertyText(m.name) === "initialize") c.initializeMethod = m;
	else c.members.push(m);
}
function normalizeBody(fn: ts.FunctionExpression | ts.ArrowFunction, f: ts.NodeFactory): ts.Block {
	return ts.isBlock(fn.body) ? fn.body : f.createBlock([f.createReturnStatement(fn.body)], true);
}
function arrowUnsafe(fn: ts.ArrowFunction): boolean {
	let bad = false;
	const v = (n: ts.Node): void => {
		if (bad) return;
		if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword || (ts.isIdentifier(n) && n.text === "arguments") || ts.isMetaProperty(n)) {
			bad = true;
			return;
		}
		if (n !== fn && ts.isFunctionLike(n)) return;
		ts.forEachChild(n, v);
	};
	v(fn.body);
	return bad;
}
function findFunctionDeclaration(scope: ScopeContext, name: string): ts.FunctionDeclaration | undefined {
	return scope.node.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name && !!s.body);
}
function hasClassEvidence(c: ClassInfo): boolean {
	return !!(c.existingClass || c.classCreateStatement || c.initializeMethod || c.baseClass || c.members.length || c.targetScopes.size || c.postClassStatements.length);
}
function promoteFunctionAlias(c: ClassInfo, s: ts.Statement, name: ts.PropertyName, id: ts.Identifier, scope: ScopeContext, o: FixPrototypeTransformerOptions): boolean {
	const fn = findFunctionDeclaration(scope, id.text);
	if (!fn?.body) return false;
	const candidate = scope.classes.get(id.text);
	if (candidate && candidate.root === fn && hasClassEvidence(candidate)) return false;
	addMethod(c, { name, kind: "method", isStatic: true, parameters: fn.parameters, body: fn.body, sourceStatement: s, sourceNode: fn, localFunction: fn });
	c.consumedStatements.add(fn);
	c.consumedStatements.add(s);
	if (candidate?.root === fn) scope.classes.delete(id.text);
	log(o, { level: "info", event: "function.promote", message: `Promoted ${id.text} to ${c.target.key}.${propertyText(name) ?? id.text}.`, className: c.target.key, node: fn });
	return true;
}
function processObject(c: ClassInfo, s: ts.Statement, obj: ts.ObjectLiteralExpression, f: ts.NodeFactory, o: FixPrototypeTransformerOptions): void {
	for (const p of obj.properties) {
		if (ts.isMethodDeclaration(p))
			addMethod(c, { name: p.name, kind: "method", isStatic: false, parameters: p.parameters, body: p.body ?? f.createBlock([], true), sourceStatement: s, sourceNode: p });
		else if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))
			addMethod(c, {
				name: p.name,
				kind: ts.isGetAccessorDeclaration(p) ? "get" : "set",
				isStatic: false,
				parameters: p.parameters,
				body: p.body ?? f.createBlock([], true),
				sourceStatement: s,
				sourceNode: p,
			});
		else if (ts.isPropertyAssignment(p)) {
			const v = p.initializer;
			if (ts.isFunctionExpression(v) || ts.isArrowFunction(v)) {
				if (ts.isArrowFunction(v) && arrowUnsafe(v)) {
					c.members.push({ name: p.name, isStatic: false, constLike: false, initializer: v, sourceStatement: s, sourceNode: p });
					report(o, { code: "UNSAFE_ARROW_FUNCTION", message: "Preserved arrow field.", node: p, className: c.target.key });
				} else addMethod(c, { name: p.name, kind: "method", isStatic: false, parameters: v.parameters, body: normalizeBody(v, f), sourceStatement: s, sourceNode: p });
			} else c.members.push({ name: p.name, isStatic: false, constLike: false, initializer: v, sourceStatement: s, sourceNode: p });
		}
	}
}
function parseInheritance(e: ts.Expression): { baseClass?: ts.Expression; members?: ts.ObjectLiteralExpression } | undefined {
	e = unwrap(e);
	if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression) || !ts.isIdentifier(e.expression.expression) || e.expression.expression.text !== "Object") return;
	const m = e.expression.name.text;
	if (m === "create" && e.arguments.length === 1) {
		const owner = prototypeOwner(e.arguments[0]!);
		return owner ? { baseClass: owner } : undefined;
	}
	if ((m === "extend" || m === "extendsObject") && e.arguments.length)
		return { baseClass: e.arguments[0], members: ts.isObjectLiteralExpression(e.arguments[1]!) ? e.arguments[1] : undefined };
	return;
}
function addAssigned(c: ClassInfo, s: ts.Statement, n: ts.PropertyName, v: ts.Expression, isStatic: boolean, f: ts.NodeFactory, o: FixPrototypeTransformerOptions): void {
	if (ts.isFunctionExpression(v) || ts.isArrowFunction(v)) {
		if (ts.isArrowFunction(v) && arrowUnsafe(v)) {
			c.members.push({ name: n, isStatic, constLike: false, initializer: v, sourceStatement: s, sourceNode: s });
			report(o, { code: "UNSAFE_ARROW_FUNCTION", message: "Preserved arrow field.", node: s, className: c.target.key });
		} else addMethod(c, { name: n, kind: "method", isStatic, parameters: v.parameters, body: normalizeBody(v, f), sourceStatement: s, sourceNode: s });
	} else
		c.members.push({
			name: n,
			isStatic,
			constLike: isStatic && !!propertyText(n) && propertyText(n) === propertyText(n)!.toUpperCase(),
			initializer: v,
			sourceStatement: s,
			sourceNode: s,
		});
	c.consumedStatements.add(s);
}
function detectAssignment(s: ts.Statement, a: ts.BinaryExpression, scope: ScopeContext, f: ts.NodeFactory, o: FixPrototypeTransformerOptions): void {
	const rootKey = expressionPath(a.left),
		root = rootKey ? resolveClass(scope, rootKey) : undefined;
	if (root?.root === s && root.target.assignmentTarget) return;
	const p = parsePrototypeLeft(a.left);
	if (p) {
		const c = resolveClass(scope, p.key);
		if (!c) return;
		if (c.definingScope !== scope) c.targetScopes.add(scope);
		if (p.member) {
			const n = nameFromAccess(p.member, f);
			if (n) addAssigned(c, s, n, a.right, false, f, o);
		} else if (ts.isObjectLiteralExpression(a.right)) {
			processObject(c, s, a.right, f, o);
			c.consumedStatements.add(s);
		} else {
			const inh = parseInheritance(a.right);
			if (inh) {
				c.baseClass = inh.baseClass;
				if (inh.members) processObject(c, s, inh.members, f, o);
				c.consumedStatements.add(s);
			}
		}
		return;
	}
	if (!ts.isPropertyAccessExpression(a.left) && !ts.isElementAccessExpression(a.left)) return;
	const owner = expressionPath(a.left.expression),
		c = owner ? resolveClass(scope, owner) : undefined;
	if (!c) return;
	if (c.definingScope !== scope) c.targetScopes.add(scope);
	const n = nameFromAccess(a.left, f);
	if (!n) return;
	if (ts.isIdentifier(a.right) && promoteFunctionAlias(c, s, n, a.right, scope, o)) return;
	addAssigned(c, s, n, a.right, true, f, o);
}
function visitAssignments(s: ts.Statement, e: ts.Expression, scope: ScopeContext, f: ts.NodeFactory, o: FixPrototypeTransformerOptions): void {
	if (!ts.isBinaryExpression(e)) return;
	if (e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
		visitAssignments(s, e.left, scope, f, o);
		visitAssignments(s, e.right, scope, f, o);
	} else if (e.operatorToken.kind === ts.SyntaxKind.EqualsToken) detectAssignment(s, e, scope, f, o);
}
function childCanResolve(node: ScopeNode): boolean {
	if (!ts.isBlock(node)) return true;
	const p = node.parent;
	if (
		!p ||
		!(ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) || ts.isMethodDeclaration(p) || ts.isAccessor(p) || ts.isConstructorDeclaration(p)) ||
		p.body !== node
	)
		return true;
	if (!(ts.isFunctionExpression(p) || ts.isArrowFunction(p))) return false;
	let e: ts.Expression = p,
		q = p.parent;
	while (q && ts.isParenthesizedExpression(q)) {
		e = q;
		q = q.parent;
	}
	return !!q && ts.isCallExpression(q) && q.expression === e;
}
function isEs5ExtendsHelperName(name: string): boolean {
	return name === "__extends" || name === "_inherits" || name === "inherits";
}

function isEs5ExtendsHelperCall(
	statement: ts.Statement,
	className: string,
	superParameter: ts.Identifier,
): boolean {
	if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
	const call = statement.expression;
	if (!ts.isIdentifier(call.expression) || !isEs5ExtendsHelperName(call.expression.text) || call.arguments.length < 2) return false;
	return ts.isIdentifier(call.arguments[0]!) &&
		call.arguments[0].text === className &&
		ts.isIdentifier(call.arguments[1]!) &&
		call.arguments[1].text === superParameter.text;
}

interface Es5FactoryContext {
	functionExpression: ts.FunctionExpression;
	callExpression: ts.CallExpression;
	superParameter: ts.Identifier;
	superExpression: ts.Expression;
}

function getEnclosingEs5FactoryContext(scope: ScopeContext): Es5FactoryContext | undefined {
	if (!ts.isBlock(scope.node)) return undefined;
	const functionExpression = scope.node.parent;
	if (!ts.isFunctionExpression(functionExpression) || functionExpression.body !== scope.node || functionExpression.parameters.length !== 1) return undefined;
	const parameter = functionExpression.parameters[0];
	if (!parameter || !ts.isIdentifier(parameter.name)) return undefined;
	let callee: ts.Expression = functionExpression;
	let parent: ts.Node = functionExpression.parent;
	while (ts.isParenthesizedExpression(parent)) {
		callee = parent;
		parent = parent.parent;
	}
	if (!ts.isCallExpression(parent) || parent.expression !== callee || parent.arguments.length !== 1) return undefined;
	return {
		functionExpression,
		callExpression: parent,
		superParameter: parameter.name,
		superExpression: parent.arguments[0]!,
	};
}

function discoverEs5Inheritance(scope: ScopeContext, options: FixPrototypeTransformerOptions): void {
	const factoryContext = getEnclosingEs5FactoryContext(scope);
	if (!factoryContext) return;
	for (const cls of [...scope.classes.values()]) {
		const helperStatement = scope.node.statements.find(statement =>
			isEs5ExtendsHelperCall(statement, cls.target.name, factoryContext.superParameter),
		);
		if (!helperStatement) continue;
		cls.baseClass = factoryContext.superExpression;
		cls.es5SuperParameter = factoryContext.superParameter;
		cls.es5SuperExpression = factoryContext.superExpression;
		cls.es5HelperStatements.add(helperStatement);
		cls.consumedStatements.add(helperStatement);
		log(options, {
			level: "info",
			event: "es5.inheritance",
			message: `Recovered ES5 inheritance ${cls.target.name}.`,
			className: cls.target.key,
			node: helperStatement,
			data: { superParameter: factoryContext.superParameter.text },
		});
	}
}

function isThisExpression(expression: ts.Expression): boolean {
	return expression.kind === ts.SyntaxKind.ThisKeyword;
}

function getEs5SuperCallArguments(
	expression: ts.Expression,
	superParameter: string,
): readonly ts.Expression[] | undefined {
	expression = unwrap(expression);
	if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
	const target = expression.expression;
	if (!ts.isIdentifier(target.expression) || target.expression.text !== superParameter || target.name.text !== "call") return undefined;
	if (!expression.arguments.length || !isThisExpression(expression.arguments[0]!)) return undefined;
	return expression.arguments.slice(1);
}

interface Es5ThisAlias {
	name: string;
	superArguments: readonly ts.Expression[];
}

interface NamespaceIife {
	statement: ts.ExpressionStatement;
	callExpression: ts.CallExpression;
	calleeExpression: ts.Expression;
	functionExpression: ts.FunctionExpression;
	parameter: ts.Identifier;
	namespaceName: string;
	namespaceArgument: ts.Expression;
	childScope: ScopeContext;
}

interface NamespaceFunctionExport {
	functionDeclaration: ts.FunctionDeclaration;
	exportStatement: ts.ExpressionStatement;
	exportName: ts.PropertyName;
	localName: string;
}

function getEs5ThisAlias(statement: ts.Statement, superParameter: string): Es5ThisAlias | undefined {
	if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
	const declaration = statement.declarationList.declarations[0];
	if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined;
	const initializer = unwrap(declaration.initializer);
	if (ts.isBinaryExpression(initializer) && initializer.operatorToken.kind === ts.SyntaxKind.BarBarToken && isThisExpression(initializer.right)) {
		const superArguments = getEs5SuperCallArguments(initializer.left, superParameter);
		if (superArguments) return { name: declaration.name.text, superArguments };
	}
	const superArguments = getEs5SuperCallArguments(initializer, superParameter);
	return superArguments ? { name: declaration.name.text, superArguments } : undefined;
}

function rewriteThisAlias(
	node: ts.Node,
	aliasName: string,
	context: ts.TransformationContext,
	factory: ts.NodeFactory,
): ts.Node {
	const visit = (child: ts.Node): ts.VisitResult<ts.Node> => {
		if (child !== node && (ts.isFunctionDeclaration(child) || ts.isFunctionExpression(child) || ts.isArrowFunction(child))) return child;
		if (ts.isIdentifier(child) && child.text === aliasName) return factory.createThis();
		return ts.visitEachChild(child, visit, context);
	};
	return ts.visitEachChild(node, visit, context);
}

function rewriteEs5ConstructorBody(
	statements: readonly ts.Statement[],
	cls: ClassInfo,
	context: ts.TransformationContext,
	factory: ts.NodeFactory,
): ts.Statement[] {
	const superParameter = cls.es5SuperParameter?.text;
	if (!superParameter) return [...statements];
	const output: ts.Statement[] = [];
	let thisAlias: Es5ThisAlias | undefined;
	for (const statement of statements) {
		const alias = getEs5ThisAlias(statement, superParameter);
		if (alias) {
			thisAlias = alias;
			output.push(factory.createExpressionStatement(factory.createCallExpression(factory.createSuper(), undefined, alias.superArguments)));
			continue;
		}
		if (ts.isExpressionStatement(statement)) {
			const superArguments = getEs5SuperCallArguments(statement.expression, superParameter);
			if (superArguments) {
				output.push(factory.createExpressionStatement(factory.createCallExpression(factory.createSuper(), undefined, superArguments)));
				continue;
			}
		}
		if (thisAlias && ts.isReturnStatement(statement) && statement.expression && ts.isIdentifier(statement.expression) && statement.expression.text === thisAlias.name) continue;
		output.push(statement);
	}
	return thisAlias
		? output.map(statement => rewriteThisAlias(statement, thisAlias!.name, context, factory) as ts.Statement)
		: output;
}

interface NamespaceClassExport {
	exportName: ts.PropertyName;
	exportStatement: ts.ExpressionStatement;
	localClass?: ts.ClassDeclaration;
	classExpression?: ts.ClassExpression;
}
function getNamespaceExportAssignment(statement: ts.Statement, namespaceName: string, factory: ts.NodeFactory): { assignment: ts.BinaryExpression; exportName: ts.PropertyName } | undefined {
	if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
	const assignment = statement.expression;
	if (!(ts.isPropertyAccessExpression(assignment.left) || ts.isElementAccessExpression(assignment.left)) || !ts.isIdentifier(assignment.left.expression) || assignment.left.expression.text !== namespaceName) return undefined;
	const exportName = nameFromAccess(assignment.left, factory);
	return exportName ? { assignment, exportName } : undefined;
}
function getNamespaceClassExports(namespace: NamespaceIife, factory: ts.NodeFactory): NamespaceClassExport[] | undefined {
	const localClasses = new Map<string, ts.ClassDeclaration>();
	for (const statement of namespace.functionExpression.body.statements) if (ts.isClassDeclaration(statement) && statement.name) localClasses.set(statement.name.text, statement);
	const exports: NamespaceClassExport[] = [];
	const usedClasses = new Set<ts.ClassDeclaration>();
	const usedExports = new Set<ts.Statement>();
	for (const statement of namespace.functionExpression.body.statements) {
		const target = getNamespaceExportAssignment(statement, namespace.namespaceName, factory);
		if (!target) continue;
		if (ts.isIdentifier(target.assignment.right)) {
			const localClass = localClasses.get(target.assignment.right.text);
			if (!localClass) continue;
			exports.push({ exportName: target.exportName, exportStatement: statement as ts.ExpressionStatement, localClass });
			usedClasses.add(localClass); usedExports.add(statement);
		} else if (ts.isClassExpression(target.assignment.right)) {
			exports.push({ exportName: target.exportName, exportStatement: statement as ts.ExpressionStatement, classExpression: target.assignment.right });
			usedExports.add(statement);
		}
	}
	if (!exports.length) return undefined;
	for (const statement of namespace.functionExpression.body.statements) {
		if (ts.isEmptyStatement(statement) || usedExports.has(statement)) continue;
		if (ts.isClassDeclaration(statement) && usedClasses.has(statement)) continue;
		return undefined;
	}
	return exports;
}
function sanitizeIdentifierPart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_$]/g, "_");
	return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}
function createHoistedClassName(namespaceName: string, exportName: string): string {
	return `${sanitizeIdentifierPart(namespaceName)}_${sanitizeIdentifierPart(exportName)}`;
}
function createHoistedNamespaceClass(sourceFile: ts.SourceFile, namespaceName: string, exportName: string, exported: NamespaceClassExport, factory: ts.NodeFactory): ts.ClassDeclaration {
	const sourceClass = exported.localClass ?? exported.classExpression!;
	const declaration = factory.createClassDeclaration(sourceClass.modifiers, factory.createIdentifier(createHoistedClassName(namespaceName, exportName)), sourceClass.typeParameters, sourceClass.heritageClauses, sourceClass.members);
	copyComments(sourceFile, sourceClass, declaration);
	return declaration;
}
function discoverNamespaceClassAugmentations(sourceFile: ts.SourceFile, scope: ScopeContext, factory: ts.NodeFactory, options: FixPrototypeTransformerOptions): void {
	for (const statement of scope.node.statements) {
		const namespace = getNamespaceIife(statement, scope);
		if (!namespace) continue;
		const owner = scope.classes.get(namespace.namespaceName);
		if (!owner?.existingClass) continue;
		const exports = getNamespaceClassExports(namespace, factory);
		if (!exports) continue;
		const names = new Set(owner.existingClass.members.map(member => member.name ? propertyText(member.name) : undefined).filter((name): name is string => name !== undefined));
		for (const exported of exports) {
			const exportName = propertyText(exported.exportName);
			if (!exportName || names.has(exportName)) continue;
			const hoisted = createHoistedNamespaceClass(sourceFile, namespace.namespaceName, exportName, exported, factory);
			owner.preClassStatements.push(hoisted);
			owner.members.push({ name: cloneName(exported.exportName, factory), isStatic: true, constLike: false, initializer: factory.createIdentifier(hoisted.name!.text), sourceStatement: statement, sourceNode: exported.localClass ?? exported.classExpression! });
			names.add(exportName);
			log(options, { level: "info", event: "namespace.class-hoist", message: `Hoisted ${namespace.namespaceName}.${exportName} as ${hoisted.name!.text}.`, className: namespace.namespaceName, node: exported.exportStatement });
		}
		owner.consumedStatements.add(statement);
	}
}
function getQualifiedOwnerKey(target: ClassTarget): string | undefined {
	if (!target.assignmentTarget) return undefined;
	const path = expressionPath(target.assignmentTarget);
	if (!path) return undefined;
	const separator = path.lastIndexOf(".");
	return separator < 0 ? undefined : path.slice(0, separator);
}
function findQualifiedOwnerClass(cls: ClassInfo): ClassInfo | undefined {
	const ownerKey = getQualifiedOwnerKey(cls.target);
	if (!ownerKey) return undefined;
	let scope: ScopeContext | undefined = cls.definingScope;
	while (scope) {
		const owner = scope.classes.get(ownerKey);
		if (owner) return owner;
		scope = scope.parent;
	}
	return undefined;
}
function createQualifiedHoistedName(ownerKey: string, className: string): string {
	return [...ownerKey.split("."), className].map(sanitizeIdentifierPart).join("_");
}
function mergeQualifiedClassFactoryMembers(
	cls: ClassInfo,
	scope: ScopeContext,
	options: FixPrototypeTransformerOptions,
): void {
	const assignment = assignmentFromStatement(cls.root);
	if (!assignment) return;
	const call = unwrap(assignment.right);
	if (!ts.isCallExpression(call)) return;
	const fn = unwrap(call.expression);
	if (!ts.isFunctionExpression(fn)) return;
	const factoryScope = scope.childScopes.get(fn.body);
	if (!factoryScope) return;
	const local = factoryScope.classes.get(cls.target.name);
	if (!local || local === cls) return;
	cls.constructorFunction = local.constructorFunction ?? cls.constructorFunction;
	cls.initializeMethod = local.initializeMethod ?? cls.initializeMethod;
	cls.baseClass = local.baseClass ?? cls.baseClass;
	cls.es5SuperParameter = local.es5SuperParameter;
	cls.es5SuperExpression = local.es5SuperExpression;
	cls.members.push(...local.members);
	for (const statement of local.consumedStatements) cls.consumedStatements.add(statement);
	factoryScope.classes.delete(cls.target.name);
	log(options, { level: "debug", event: "qualified-class.factory", message: `Collected class factory ${cls.target.key}.`, className: cls.target.key, node: cls.root, data: { members: cls.members.length } });
}
function rewriteHoistedClassSelfReferences(
	declaration: ts.ClassDeclaration,
	originalName: string,
	hoistedName: string,
	context: ts.TransformationContext,
	factory: ts.NodeFactory,
): ts.ClassDeclaration {
	if (originalName === hoistedName) return declaration;
	const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
		if (ts.isIdentifier(node) && node.text === originalName && !nonReference(node)) {
			return factory.createIdentifier(hoistedName);
		}
		return ts.visitEachChild(node, visit, context);
	};
	return ts.visitEachChild(declaration, visit, context);
}

function emitHoistedClassDeclaration(
	sourceFile: ts.SourceFile,
	cls: ClassInfo,
	hoistedName: string,
	factory: ts.NodeFactory,
	context: ts.TransformationContext,
	options: FixPrototypeTransformerOptions,
): ts.ClassDeclaration {
	let declaration = factory.createClassDeclaration(undefined, factory.createIdentifier(hoistedName), undefined, heritage(cls, factory), emitMembers(sourceFile, cls, factory, context, options));
	declaration = rewriteHoistedClassSelfReferences(declaration, cls.target.name, hoistedName, context, factory);
	copyComments(sourceFile, cls.root, declaration);
	return declaration;
}
function addHoistedClassAlias(owner: ClassInfo, cls: ClassInfo, hoistedName: string, factory: ts.NodeFactory): void {
	const exists = owner.members.some(member => propertyText(member.name) === cls.target.name) ||
		(owner.existingClass?.members.some(member => !!member.name && propertyText(member.name) === cls.target.name) ?? false);
	if (exists) return;
	owner.members.push({ name: factory.createIdentifier(cls.target.name), isStatic: true, constLike: false, initializer: factory.createIdentifier(hoistedName), sourceStatement: cls.root, sourceNode: cls.root });
}
function discoverQualifiedClassHoists(
	sourceFile: ts.SourceFile,
	scope: ScopeContext,
	factory: ts.NodeFactory,
	context: ts.TransformationContext,
	options: FixPrototypeTransformerOptions,
): void {
	if ((options.namespaceClassStrategy ?? "hoist") !== "hoist") return;
	for (const cls of [...scope.classes.values()]) {
		if (!cls.target.assignmentTarget || cls.existingClass || cls.hoistedIntoOwner) continue;

		/*
		 * A qualified factory root may initially contain only its constructor.
		 * Merge the inner factory ClassInfo before checking convertibility so
		 * members such as ScriptHistory.prototype.store are visible.
		 */
		mergeQualifiedClassFactoryMembers(cls, scope, options);
		if (!isConvertible(cls)) continue;

		const owner = findQualifiedOwnerClass(cls);
		const ownerKey = getQualifiedOwnerKey(cls.target);
		/*
		 * The owner may itself be a legacy function/prototype class that has
		 * not been emitted yet. Requiring existingClass incorrectly skips
		 * owners such as `var snd_Xplore = function () {}`.
		 */
		if (!owner || !ownerKey || !isConvertible(owner)) continue;
		const hoistedName = createQualifiedHoistedName(ownerKey, cls.target.name);
		owner.preClassStatements.push(emitHoistedClassDeclaration(sourceFile, cls, hoistedName, factory, context, options));
		addHoistedClassAlias(owner, cls, hoistedName, factory);
		cls.hoistedIntoOwner = owner;
		cls.hoistedName = hoistedName;
		for (const statement of cls.consumedStatements) owner.consumedStatements.add(statement);
		log(options, { level: "info", event: "qualified-class.hoist", message: `Hoisted ${cls.target.key} as ${hoistedName}.`, fileName: sourceFile.fileName, className: cls.target.key, node: cls.root, data: { owner: owner.target.key, hoistedName } });
	}
}

function processScope(node: ScopeNode, scope: ScopeContext, f: ts.NodeFactory, o: FixPrototypeTransformerOptions, ctx: ts.TransformationContext): void {
	for (const s of node.statements) detectDeclarationRoots(s, scope, o);
	discoverEs5Inheritance(scope, o);
	/*
* Detect:
*
* class CG_RecordUtils {
* static getRecord = getRecord;
* }
*
* function getRecord() {}
*/
	for (const cls of scope.classes.values()) {
		if (cls.existingClass) {
			promoteExistingClassAliases(
				cls,
				scope,
				o,
			);
		}
	}
	for (const s of node.statements) {
		detectQualifiedRoots(s, scope, o);
		detectQualifiedClassFactoryRoot(s, scope, o);
	}
	for (const s of node.statements) if (ts.isExpressionStatement(s)) visitAssignments(s, s.expression, scope, f, o);
	for (const s of node.statements) {
		const v = (n: ts.Node): void => {
			if (ts.isBlock(n) || ts.isModuleBlock(n)) {
				const c = createScope(n, scope, childCanResolve(n));
				scope.childScopes.set(n, c);
				processScope(n, c, f, o, ctx);
				return;
			}
			ts.forEachChild(n, v);
		};
		v(s);
	}
	discoverNamespaceClassAugmentations(node.getSourceFile(), scope, f, o);
	discoverQualifiedClassHoists(node.getSourceFile(), scope, f, ctx, o);
}
function isConvertible(c: ClassInfo): boolean {
	if (c.hoistedIntoOwner) return false;
	return (
		c.convertible &&
		(c.existingClass ?
			!!(c.members.length || c.initializeMethod || c.preClassStatements.length || c.postClassStatements.length)
			: !!(c.classCreateStatement || c.initializeMethod || c.baseClass || c.members.length || c.targetScopes.size || c.postClassStatements.length))
	);
}

function getPromoted(c: ClassInfo, checker?: ts.TypeChecker): Map<string, PromotedFunction> {
	const r = new Map<string, PromotedFunction>();
	for (const m of c.members)
		if (isMethod(m) && m.localFunction?.name) {
			const n = propertyText(m.name);
			if (n) r.set(m.localFunction.name.text, { methodName: n, declaration: m.localFunction, symbol: checker?.getSymbolAtLocation(m.localFunction.name) });
		}
	return r;
}
function nonReference(id: ts.Identifier): boolean {
	const p = id.parent;
	return (
		(ts.isVariableDeclaration(p) && p.name === id) ||
		(ts.isParameter(p) && p.name === id) ||
		(ts.isFunctionLike(p) && p.name === id) ||
		(ts.isClassLike(p) && p.name === id) ||
		(ts.isBindingElement(p) && p.name === id) ||
		(ts.isPropertyAccessExpression(p) && p.name === id) ||
		(ts.isPropertyAssignment(p) && p.name === id) ||
		(ts.isMethodDeclaration(p) && p.name === id) ||
		(ts.isPropertyDeclaration(p) && p.name === id) ||
		(ts.isAccessor(p) && p.name === id) ||
		(ts.isLabeledStatement(p) && p.label === id) ||
		((ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === id)
	);
}
function bindingNames(n: ts.BindingName, out: Set<string>): void {
	if (ts.isIdentifier(n)) {
		out.add(n.text);
		return;
	}
	for (const e of n.elements) if (!ts.isOmittedExpression(e)) bindingNames(e.name, out);
}
function collectBindings(
	node: ts.Node,
): Set<string> {
	const bindings =
		new Set<string>();

	const visit = (
		child: ts.Node,
	): void => {
		/*
		 * Register declarations introduced in the current
		 * scope, but do not descend into nested scopes.
		 */
		if (
			child !== node &&
			ts.isFunctionDeclaration(child)
		) {
			if (child.name) {
				bindings.add(
					child.name.text,
				);
			}

			return;
		}

		if (
			child !== node &&
			ts.isClassDeclaration(child)
		) {
			if (child.name) {
				bindings.add(
					child.name.text,
				);
			}

			return;
		}

		if (
			child !== node &&
			(
				ts.isFunctionExpression(child) ||
				ts.isArrowFunction(child) ||
				ts.isClassExpression(child)
			)
		) {
			return;
		}

		if (
			ts.isVariableDeclaration(child)
		) {
			bindingNames(
				child.name,
				bindings,
			);
		}
		else if (
			ts.isParameter(child)
		) {
			bindingNames(
				child.name,
				bindings,
			);
		}
		else if (
			ts.isBindingElement(child)
		) {
			bindingNames(
				child.name,
				bindings,
			);
		}
		else if (
			ts.isCatchClause(child) &&
			child.variableDeclaration
		) {
			bindingNames(
				child.variableDeclaration.name,
				bindings,
			);
		}

		ts.forEachChild(
			child,
			visit,
		);
	};

	ts.forEachChild(
		node,
		visit,
	);

	return bindings;
}

function rewritePromoted(
	body: ts.Block,
	className: string,
	promoted:
		ReadonlyMap<
			string,
			PromotedFunction
		>,
	checker: ts.TypeChecker | undefined,
	factory: ts.NodeFactory,
): ts.Block {
	if (!promoted.size) {
		return body;
	}

	const transformer:
		ts.TransformerFactory<ts.Block> =
		context =>
			root => {
				const visit = (
					node: ts.Node,
					shadowed:
						ReadonlySet<string>,
				): ts.VisitResult<ts.Node> => {
					let currentShadowed =
						shadowed;

					/*
					 * A nested function introduces a new
					 * lexical scope.
					 *
					 * Do not apply the outer method's local
					 * bindings to the root block itself.
					 */
					if (
						node !== root &&
						(
							ts.isFunctionDeclaration(
								node,
							) ||
							ts.isFunctionExpression(
								node,
							) ||
							ts.isArrowFunction(
								node,
							)
						)
					) {
						const nestedShadowed =
							new Set(shadowed);

						if (
							(
								ts.isFunctionDeclaration(
									node,
								) ||
								ts.isFunctionExpression(
									node,
								)
							) &&
							node.name
						) {
							nestedShadowed.add(
								node.name.text,
							);
						}

						for (
							const parameter
							of node.parameters
						) {
							bindingNames(
								parameter.name,
								nestedShadowed,
							);
						}

						for (
							const binding
							of collectBindings(node)
						) {
							nestedShadowed.add(
								binding,
							);
						}

						currentShadowed =
							nestedShadowed;
					}

					if (
						ts.isIdentifier(node) &&
						!nonReference(node)
					) {
						const promotedFunction =
							promoted.get(
								node.text,
							);

						if (promotedFunction) {
							let matches = false;

							if (
								checker &&
								promotedFunction.symbol
							) {
								const referenceSymbol =
									checker
										.getSymbolAtLocation(
											node,
										);

								matches =
									referenceSymbol ===
									promotedFunction.symbol;
							}
							else {
								matches =
									!currentShadowed.has(
										node.text,
									);
							}

							if (matches) {
								return factory
									.createPropertyAccessExpression(
										factory
											.createIdentifier(
												className,
											),
										factory
											.createIdentifier(
												promotedFunction
													.methodName,
											),
									);
							}
						}
					}

					return ts.visitEachChild(
						node,
						child =>
							visit(
								child,
								currentShadowed,
							),
						context,
					);
				};

				/*
				 * Start empty. The promoted function names
				 * belong to the surrounding class-factory
				 * scope and must remain eligible for
				 * qualification.
				 */
				return ts.visitEachChild(
					root,
					node =>
						visit(
							node,
							new Set<string>(),
						),
					context,
				);
			};

	const result = ts.transform(
		body,
		[transformer],
	);

	try {
		return result
			.transformed[0]!;
	}
	finally {
		result.dispose();
	}
}

function copyComments(sf: ts.SourceFile, from: ts.Node, to: ts.Node): void {
	if (ts.getSyntheticLeadingComments(to)?.length) return;
	const text = sf.getFullText();
	for (const r of ts.getLeadingCommentRanges(text, from.pos) ?? []) {
		const line = r.kind === ts.SyntaxKind.SingleLineCommentTrivia;
		ts.addSyntheticLeadingComment(to, r.kind, text.slice(r.pos + 2, r.end - (line ? 0 : 2)), true);
	}
}
function emitMethod(
	sf: ts.SourceFile,
	c: ClassInfo,
	m: MethodInfo,
	p: ReadonlyMap<string, PromotedFunction>,
	checker: ts.TypeChecker | undefined,
	f: ts.NodeFactory,
): ts.ClassElement {
	const mods = m.isStatic ? [f.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined,
		body = m.localFunction ? rewritePromoted(m.body, c.target.name, p, checker, f) : m.body;
	let r: ts.ClassElement;
	if (m.kind === "get") r = f.createGetAccessorDeclaration(mods, cloneName(m.name, f), [], undefined, body);
	else if (m.kind === "set") r = f.createSetAccessorDeclaration(mods, cloneName(m.name, f), m.parameters, body);
	else r = f.createMethodDeclaration(mods, undefined, cloneName(m.name, f), undefined, undefined, m.parameters, undefined, body);
	copyComments(sf, m.sourceNode, r);
	return r;
}
function emitProperty(sf: ts.SourceFile, p: PropertyInfo, f: ts.NodeFactory): ts.PropertyDeclaration {
	const mods = p.isStatic ? [f.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined;
	let i = p.initializer;
	if (p.constLike && i) {
		if (/\.[cm]?jsx?$/i.test(sf.fileName)) {
			const w = ts.isParenthesizedExpression(i) ? i : f.createParenthesizedExpression(i);
			i = ts.addSyntheticLeadingComment(w, ts.SyntaxKind.MultiLineCommentTrivia, "* @type {const} ", false);
		} else i = f.createAsExpression(i, f.createTypeReferenceNode("const"));
	}
	const r = f.createPropertyDeclaration(mods, cloneName(p.name, f), undefined, undefined, i);
	copyComments(sf, p.sourceNode, r);
	return r;
}
function emitMembers(
	sf: ts.SourceFile,
	c: ClassInfo,
	f: ts.NodeFactory,
	ctx: ts.TransformationContext,
	o: FixPrototypeTransformerOptions,
): ts.ClassElement[] {
	const out: ts.ClassElement[] = [],
		params = c.initializeMethod?.parameters ?? c.constructorFunction?.parameters ?? [];
	const body = rewriteEs5ConstructorBody(
		c.constructorFunction?.body?.statements ?? [],
		c,
		ctx,
		f,
	);
	if (c.baseClass && !body.some((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.kind === ts.SyntaxKind.SuperKeyword)) {
		body.unshift(f.createExpressionStatement(f.createCallExpression(f.createSuper(), undefined, [])));
		report(o, { code: "MISSING_SUPER_CALL", message: `Inserted super() into ${c.target.key}.`, node: c.root, className: c.target.key });
	}
	if (c.initializeMethod) body.push(...c.initializeMethod.body.statements);
	if (params.length || body.length) out.push(f.createConstructorDeclaration(undefined, params, f.createBlock(body, true)));
	const promoted = getPromoted(c, o.checker);
	for (const m of [...c.members].sort((a, b) => a.sourceNode.getStart(sf) - b.sourceNode.getStart(sf)))
		out.push(isMethod(m) ? emitMethod(sf, c, m, promoted, o.checker, f) : emitProperty(sf, m, f));
	return out;
}
function heritage(c: ClassInfo, f: ts.NodeFactory): ts.HeritageClause[] | undefined {
	return c.baseClass ? [f.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [f.createExpressionWithTypeArguments(c.baseClass, undefined)])] : undefined;
}

function emitClass(
    sourceFile: ts.SourceFile,
    cls: ClassInfo,
    factory: ts.NodeFactory,
    context: ts.TransformationContext,
    options: FixPrototypeTransformerOptions,
): ts.Statement {
    if (cls.existingClass) {
        const existingMembers =
            cls.existingClass.members.filter(
                member =>
                    !cls.replacedExistingMembers.has(
                        member,
                    ),
            );

        const existingNames =
            new Set(
                existingMembers
                    .map(member =>
                        member.name
                            ? propertyText(
                                  member.name,
                              )
                            : undefined,
                    )
                    .filter(
                        (
                            name,
                        ): name is string =>
                            name !== undefined,
                    ),
            );

        const promotedFunctions =
            getPromoted(
                cls,
                options.checker,
            );

        const additionalMembers =
            cls.members
                .filter(member => {
                    const name =
                        propertyText(
                            member.name,
                        );

                    return (
                        name === undefined ||
                        !existingNames.has(name)
                    );
                })
                .map(member =>
                    isMethod(member)
                        ? emitMethod(
                              sourceFile,
                              cls,
                              member,
                              promotedFunctions,
                              options.checker,
                              factory,
                          )
                        : emitProperty(
                              sourceFile,
                              member,
                              factory,
                          ),
                );

        return factory
            .updateClassDeclaration(
                cls.existingClass,
                cls.existingClass.modifiers,
                cls.existingClass.name,
                cls.existingClass
                    .typeParameters,
                cls.existingClass
                    .heritageClauses,
                [
                    ...existingMembers,
                    ...additionalMembers,
                ],
            );
    }

    const members =
        emitMembers(
            sourceFile,
            cls,
            factory,
            context,
            options,
        );

    if (cls.target.assignmentTarget) {
        return factory
            .createExpressionStatement(
                factory
                    .createBinaryExpression(
                        cls.target
                            .assignmentTarget,

                        factory.createToken(
                            ts.SyntaxKind
                                .EqualsToken,
                        ),

                        factory
                            .createClassExpression(
                                undefined,
                                factory
                                    .createIdentifier(
                                        cls.target
                                            .name,
                                    ),
                                undefined,
                                heritage(
                                    cls,
                                    factory,
                                ),
                                members,
                            ),
                    ),
            );
    }

    return factory.createClassDeclaration(
        undefined,
        cls.target.name,
        undefined,
        heritage(
            cls,
            factory,
        ),
        members,
    );
}

function classesTargeting(scope: ScopeContext): ClassInfo[] {
	const r: ClassInfo[] = [];
	let p = scope.parent;
	while (p) {
		for (const c of p.classes.values()) if (c.targetScopes.has(scope) && isConvertible(c)) r.push(c);
		p = p.parent;
	}
	return r;
}
function getIife(e: ts.Expression): { callExpression: ts.CallExpression; calleeExpression: ts.Expression; functionExpression: ts.FunctionExpression } | undefined {
	const call = unwrap(e);
	if (!ts.isCallExpression(call)) return;
	const callee = call.expression,
		fn = unwrap(callee);
	return ts.isFunctionExpression(fn) ? { callExpression: call, calleeExpression: callee, functionExpression: fn } : undefined;
}
function getClassFactoryIife(s: ts.Statement, scope: ScopeContext, o: FixPrototypeTransformerOptions): ClassFactoryIife | undefined {
	if (!ts.isVariableStatement(s) || s.declarationList.declarations.length !== 1) return;
	const d = s.declarationList.declarations[0];
	if (!d || !ts.isIdentifier(d.name) || !d.initializer) return;
	const i = getIife(d.initializer);
	if (!i) return;
	const child = scope.childScopes.get(i.functionExpression.body);
	if (!child) return;
	let ret: ts.ReturnStatement | undefined;
	for (let x = i.functionExpression.body.statements.length - 1; x >= 0; x--) {
		const q = i.functionExpression.body.statements[x]!;
		if (ts.isEmptyStatement(q)) continue;
		if (ts.isReturnStatement(q)) ret = q;
		break;
	}
	if (!ret?.expression || !ts.isIdentifier(ret.expression)) return;
	const c = child.classes.get(ret.expression.text);
	if (!c || !isConvertible(c) || d.name.text !== c.target.name) return;
	return {
		statement: s,
		declaration: d,
		callExpression: i.callExpression,
		calleeExpression: i.calleeExpression,
		functionExpression: i.functionExpression,
		childScope: child,
		returnedClass: c,
	};
}
function rewriteClassFactoryIife(
    sourceFile: ts.SourceFile,
    statement: ts.Statement,
    scope: ScopeContext,
    factory: ts.NodeFactory,
    context: ts.TransformationContext,
    options: FixPrototypeTransformerOptions,
): ts.Statement | undefined {
    const classFactory = getClassFactoryIife(
        statement,
        scope,
        options,
    );

    if (!classFactory) {
        return undefined;
    }

    const {
        declaration,
        callExpression,
        calleeExpression,
        functionExpression,
        childScope,
        returnedClass,
    } = classFactory;

    log(options, {
        level: "info",
        event: "iife.class-factory",
        message:
            `Transforming class-returning IIFE ` +
            `${returnedClass.target.key}.`,
        fileName: sourceFile.fileName,
        scopeKind: childScope.node.kind,
        className: returnedClass.target.key,
        node: statement,
        data: {
            variableName:
                ts.isIdentifier(declaration.name)
                    ? declaration.name.text
                    : undefined,

            members:
                returnedClass.members.length,

            targetScopes:
                returnedClass.targetScopes.size,

            location: nodeLocation(
                sourceFile,
                statement,
            ),
        },
    });

    /*
     * The returned class belongs to the current factory IIFE.
     *
     * Discovery may have added target scopes while collecting
     * assignments from nested resolvable scopes. Those scopes
     * must not relocate this class away from its factory body.
     */
    const originalTargetScopes =
        new Set(
            returnedClass.targetScopes,
        );

    returnedClass.targetScopes.clear();

    let transformedBody: ts.Block;

    try {
        transformedBody = transformScope(
            sourceFile,
            functionExpression.body,
            childScope,
            factory,
            context,
            options,
        );
    }
    finally {
        for (
            const targetScope
            of originalTargetScopes
        ) {
            returnedClass.targetScopes.add(
                targetScope,
            );
        }
    }

    /*
     * Collapse:
     *
     * var Foo = (function () {
     *     class Foo {
     *         ...
     *     }
     *
     *     return Foo;
     * })();
     *
     * into:
     *
     * class Foo {
     *     ...
     * }
     *
     * Only do this when no private declarations, initialization
     * statements, or other closure state remain in the IIFE.
     */
    const significantStatements =
        transformedBody.statements.filter(
            transformedStatement =>
                !ts.isEmptyStatement(
                    transformedStatement,
                ),
        );

    if (
        significantStatements.length === 2
    ) {
        const [
            classStatement,
            returnStatement,
        ] = significantStatements;

        const outerName =
            ts.isIdentifier(declaration.name)
                ? declaration.name.text
                : undefined;

        const className =
            classStatement &&
            ts.isClassDeclaration(
                classStatement,
            ) &&
            classStatement.name
                ? classStatement.name.text
                : undefined;

        const returnedName =
            returnStatement &&
            ts.isReturnStatement(
                returnStatement,
            ) &&
            returnStatement.expression &&
            ts.isIdentifier(
                returnStatement.expression,
            )
                ? returnStatement
                      .expression.text
                : undefined;

        if (
            outerName &&
            className === outerName &&
            returnedName === outerName &&
            classStatement &&
            ts.isClassDeclaration(
                classStatement,
            )
        ) {
            log(options, {
                level: "info",
                event:
                    "iife.class-factory.unwrap",
                message:
                    `Unwrapped trivial class factory ` +
                    `${outerName}.`,
                fileName:
                    sourceFile.fileName,
                className:
                    outerName,
                node:
                    statement,
                data: {
                    location:
                        nodeLocation(
                            sourceFile,
                            statement,
                        ),
                },
            });

            /*
             * Preserve comments attached to the outer variable
             * declaration, such as typedef or class documentation.
             *
             * Do not copy them if the generated class already has
             * synthetic comments.
             */
            copyComments(
                sourceFile,
                statement,
                classStatement,
            );

            return classStatement;
        }
    }

    /*
     * The factory still has meaningful private state, helper
     * functions, side effects, or initialization statements.
     *
     * Preserve the IIFE and update only its transformed body.
     */
    const transformedFunction =
        factory.updateFunctionExpression(
            functionExpression,
            functionExpression.modifiers,
            functionExpression.asteriskToken,
            functionExpression.name,
            functionExpression.typeParameters,
            functionExpression.parameters,
            functionExpression.type,
            transformedBody,
        );

    /*
     * Preserve parentheses around:
     *
     * (function () {
     * })()
     */
    const transformedCallee =
        ts.isParenthesizedExpression(
            calleeExpression,
        )
            ? factory
                  .updateParenthesizedExpression(
                      calleeExpression,
                      transformedFunction,
                  )
            : transformedFunction;

    const transformedCall =
        factory.updateCallExpression(
            callExpression,
            transformedCallee,
            callExpression.typeArguments,
            callExpression.arguments,
        );

    const originalInitializer =
        declaration.initializer!;

    /*
     * Preserve parentheses around the entire initializer if
     * the original source used them.
     */
    const transformedInitializer =
        ts.isParenthesizedExpression(
            originalInitializer,
        )
            ? factory
                  .updateParenthesizedExpression(
                      originalInitializer,
                      transformedCall,
                  )
            : transformedCall;

    const transformedDeclaration =
        factory.updateVariableDeclaration(
            declaration,
            declaration.name,
            declaration.exclamationToken,
            declaration.type,
            transformedInitializer,
        );

    const transformedDeclarationList =
        factory
            .updateVariableDeclarationList(
                classFactory.statement
                    .declarationList,
                [transformedDeclaration],
            );

    return factory.updateVariableStatement(
        classFactory.statement,
        classFactory.statement.modifiers,
        transformedDeclarationList,
    );
}
function getNamespaceInitializationName(expression: ts.Expression): string | undefined {
	expression = unwrap(expression);
	if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.BarBarToken || !ts.isIdentifier(expression.left)) return undefined;
	const namespaceName = expression.left.text;
	const right = unwrap(expression.right);
	if (!ts.isBinaryExpression(right) || right.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
		!ts.isIdentifier(right.left) || right.left.text !== namespaceName ||
		!ts.isObjectLiteralExpression(right.right) || right.right.properties.length !== 0) return undefined;
	return namespaceName;
}

function getNamespaceIife(statement: ts.Statement, scope: ScopeContext): NamespaceIife | undefined {
	if (!ts.isExpressionStatement(statement)) return undefined;
	const callExpression = unwrap(statement.expression);
	if (!ts.isCallExpression(callExpression)) return undefined;
	const calleeExpression = callExpression.expression;
	const functionExpression = unwrap(calleeExpression);
	if (!ts.isFunctionExpression(functionExpression) || functionExpression.parameters.length !== 1 || callExpression.arguments.length !== 1) return undefined;
	const parameter = functionExpression.parameters[0];
	if (!parameter || !ts.isIdentifier(parameter.name)) return undefined;
	const namespaceArgument = callExpression.arguments[0]!;
	const namespaceName = getNamespaceInitializationName(namespaceArgument);
	if (!namespaceName || parameter.name.text !== namespaceName) return undefined;
	const childScope = scope.childScopes.get(functionExpression.body);
	if (!childScope) return undefined;
	return { statement, callExpression, calleeExpression, functionExpression, parameter: parameter.name, namespaceName, namespaceArgument, childScope };
}

function getNamespaceFunctionExports(
	body: ts.Block,
	namespaceName: string,
	factory: ts.NodeFactory,
): NamespaceFunctionExport[] {
	const functions = new Map<string, ts.FunctionDeclaration>();
	for (const statement of body.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) functions.set(statement.name.text, statement);
	}
	const exports: NamespaceFunctionExport[] = [];
	for (const statement of body.statements) {
		if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
		const assignment = statement.expression;
		if (!(ts.isPropertyAccessExpression(assignment.left) || ts.isElementAccessExpression(assignment.left)) ||
			!ts.isIdentifier(assignment.left.expression) || assignment.left.expression.text !== namespaceName || !ts.isIdentifier(assignment.right)) continue;
		const functionDeclaration = functions.get(assignment.right.text);
		const exportName = nameFromAccess(assignment.left, factory);
		if (functionDeclaration && exportName) exports.push({ functionDeclaration, exportStatement: statement, exportName, localName: assignment.right.text });
	}
	return exports;
}

function rewriteNamespaceFunctionReferences(
	body: ts.Block,
	namespaceName: string,
	exports: ReadonlyMap<string, string>,
	declarations: ReadonlyMap<string, ts.FunctionDeclaration>,
	checker: ts.TypeChecker | undefined,
	factory: ts.NodeFactory,
): ts.Block {
	if (!exports.size) return body;
	const transformer: ts.TransformerFactory<ts.Block> = context => root => {
		const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
			if (ts.isIdentifier(node) && !nonReference(node)) {
				const exportName = exports.get(node.text);
				if (exportName) {
					let matches = true;
					if (checker) {
						const declaration = declarations.get(node.text);
						const declarationSymbol = declaration?.name ? checker.getSymbolAtLocation(declaration.name) : undefined;
						const referenceSymbol = checker.getSymbolAtLocation(node);
						if (declarationSymbol && referenceSymbol) matches = declarationSymbol === referenceSymbol;
					}
					if (matches) return factory.createPropertyAccessExpression(factory.createIdentifier(namespaceName), factory.createIdentifier(exportName));
				}
			}
			return ts.visitEachChild(node, visit, context);
		};
		return ts.visitEachChild(root, visit, context);
	};
	const result = ts.transform(body, [transformer]);
	try { return result.transformed[0]!; }
	finally { result.dispose(); }
}

function promoteNamespaceFunctions(
	sourceFile: ts.SourceFile,
	body: ts.Block,
	namespaceName: string,
	factory: ts.NodeFactory,
	options: FixPrototypeTransformerOptions,
): ts.Block {
	const exports = getNamespaceFunctionExports(body, namespaceName, factory);
	if (!exports.length) return body;
	const exportMap = new Map<string, string>();
	const declarations = new Map<string, ts.FunctionDeclaration>();
	for (const exported of exports) {
		exportMap.set(exported.localName, propertyText(exported.exportName) ?? exported.localName);
		declarations.set(exported.localName, exported.functionDeclaration);
	}
	const removed = new Set<ts.Statement>(exports.map(item => item.functionDeclaration));
	const replacements = new Map<ts.Statement, ts.Statement>();
	for (const exported of exports) {
		const rewrittenBody = rewriteNamespaceFunctionReferences(
			exported.functionDeclaration.body!, namespaceName, exportMap, declarations, options.checker, factory,
		);
		const functionExpression = factory.createFunctionExpression(
			undefined,
			exported.functionDeclaration.asteriskToken,
			factory.createIdentifier(exported.localName),
			exported.functionDeclaration.typeParameters,
			exported.functionDeclaration.parameters,
			exported.functionDeclaration.type,
			rewrittenBody,
		);
		const assignment = exported.exportStatement.expression as ts.BinaryExpression;
		const replacement = factory.updateExpressionStatement(
			exported.exportStatement,
			factory.updateBinaryExpression(assignment, assignment.left, assignment.operatorToken, functionExpression),
		);
		copyComments(sourceFile, exported.functionDeclaration, replacement);
		replacements.set(exported.exportStatement, replacement);
		log(options, { level: "info", event: "namespace.function-promote", message: `Promoted ${namespaceName}.${propertyText(exported.exportName) ?? exported.localName}.`, className: namespaceName, node: exported.functionDeclaration });
	}
	const statements: ts.Statement[] = [];
	for (const statement of body.statements) {
		if (removed.has(statement)) continue;
		statements.push(replacements.get(statement) ?? statement);
	}
	return factory.updateBlock(body, statements);
}

function collapseNamespaceBodyToClass(
	sourceFile: ts.SourceFile,
	body: ts.Block,
	namespaceName: string,
	factory: ts.NodeFactory,
): ts.ClassDeclaration | undefined {
	const members: ts.ClassElement[] = [];
	for (const statement of body.statements) {
		if (ts.isEmptyStatement(statement)) continue;
		if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) ||
			statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
		const assignment = statement.expression;
		if (!(ts.isPropertyAccessExpression(assignment.left) || ts.isElementAccessExpression(assignment.left)) ||
			!ts.isIdentifier(assignment.left.expression) || assignment.left.expression.text !== namespaceName ||
			!ts.isFunctionExpression(assignment.right)) return undefined;
		const name = nameFromAccess(assignment.left, factory);
		if (!name) return undefined;
		const functionExpression = assignment.right;
		const modifiers: ts.Modifier[] = [factory.createModifier(ts.SyntaxKind.StaticKeyword)];
		for (const modifier of functionExpression.modifiers ?? []) {
			if (modifier.kind === ts.SyntaxKind.AsyncKeyword) modifiers.push(factory.createModifier(ts.SyntaxKind.AsyncKeyword));
		}
		const method = factory.createMethodDeclaration(
			modifiers,
			functionExpression.asteriskToken,
			name,
			undefined,
			functionExpression.typeParameters,
			functionExpression.parameters,
			functionExpression.type,
			functionExpression.body,
		);
		copyComments(sourceFile, statement, method);
		members.push(method);
	}
	if (!members.length) return undefined;
	return factory.createClassDeclaration(
		undefined,
		factory.createIdentifier(namespaceName),
		undefined,
		undefined,
		members,
	);
}

function isUninitializedNamespaceVariable(
	statement: ts.Statement,
	classNames: ReadonlySet<string>,
): boolean {
	if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return false;
	const declaration = statement.declarationList.declarations[0];
	return !!declaration && ts.isIdentifier(declaration.name) && !declaration.initializer && classNames.has(declaration.name.text);
}

function rewriteNamespaceIife(
	sourceFile: ts.SourceFile,
	statement: ts.Statement,
	scope: ScopeContext,
	factory: ts.NodeFactory,
	context: ts.TransformationContext,
	options: FixPrototypeTransformerOptions,
): ts.Statement | undefined {
	const namespace = getNamespaceIife(statement, scope);
	if (!namespace) return undefined;
	log(options, { level: "info", event: "namespace.transform", message: `Transforming namespace ${namespace.namespaceName}.`, fileName: sourceFile.fileName, scopeKind: namespace.childScope.node.kind, node: statement, data: { namespace: namespace.namespaceName, location: nodeLocation(sourceFile, statement) } });
	const transformedBody = transformScope(sourceFile, namespace.functionExpression.body, namespace.childScope, factory, context, options);
	const promotedBody = promoteNamespaceFunctions(sourceFile, transformedBody, namespace.namespaceName, factory, options);
	const collapsedClass = collapseNamespaceBodyToClass(sourceFile, promotedBody, namespace.namespaceName, factory);
	if (collapsedClass) {
		copyComments(sourceFile, statement, collapsedClass);
		log(options, {
			level: "info",
			event: "namespace.unwrap-class",
			message: `Collapsed namespace ${namespace.namespaceName} to a static class.`,
			fileName: sourceFile.fileName,
			className: namespace.namespaceName,
			node: statement,
		});
		return collapsedClass;
	}
	const transformedFunction = factory.updateFunctionExpression(
		namespace.functionExpression,
		namespace.functionExpression.modifiers,
		namespace.functionExpression.asteriskToken,
		namespace.functionExpression.name,
		namespace.functionExpression.typeParameters,
		namespace.functionExpression.parameters,
		namespace.functionExpression.type,
		promotedBody,
	);
	const transformedCallee = ts.isParenthesizedExpression(namespace.calleeExpression)
		? factory.updateParenthesizedExpression(namespace.calleeExpression, transformedFunction)
		: transformedFunction;
	const transformedCall = factory.updateCallExpression(namespace.callExpression, transformedCallee, namespace.callExpression.typeArguments, namespace.callExpression.arguments);
	log(options, { level: "debug", event: "namespace.transformed", message: `Completed namespace body transform for ${namespace.namespaceName}.`, fileName: sourceFile.fileName, node: statement });
	return factory.updateExpressionStatement(namespace.statement, transformedCall);
}

function transformNested<T extends ts.Node>(
	sf: ts.SourceFile,
	node: T,
	scope: ScopeContext,
	f: ts.NodeFactory,
	ctx: ts.TransformationContext,
	o: FixPrototypeTransformerOptions,
): T {
	const v = (n: ts.Node): ts.VisitResult<ts.Node> => {
		if (ts.isBlock(n) || ts.isModuleBlock(n)) {
			const c = scope.childScopes.get(n);
			if (c) return transformScope(sf, n, c, f, ctx, o);
		}
		return ts.visitEachChild(n, v, ctx);
	};
	return ts.visitEachChild(node, v, ctx) as T;
}
function rootClass(s: ts.Statement, scope: ScopeContext): ClassInfo | undefined {
	return [...scope.classes.values()].find((c) => c.root === s);
}
function transformScope<T extends ScopeNode>(
	sf: ts.SourceFile,
	node: T,
	scope: ScopeContext,
	f: ts.NodeFactory,
	ctx: ts.TransformationContext,
	o: FixPrototypeTransformerOptions,
): T {
	const consumed = new Set<ts.Statement>();
	for (const c of scope.classes.values()) if (isConvertible(c)) for (const s of c.consumedStatements) consumed.add(s);
	for (const c of classesTargeting(scope)) for (const s of c.consumedStatements) if (node.statements.includes(s)) consumed.add(s);
	const out: ts.Statement[] = [],
		emitted = new Set<string>();
	for (const s of node.statements) {
		const factory = rewriteClassFactoryIife(sf, s, scope, f, ctx, o);
		if (factory) {
			out.push(factory);
			continue;
		}
		const namespace = consumed.has(s) ? undefined : rewriteNamespaceIife(sf, s, scope, f, ctx, o);
		if (namespace) {
			out.push(namespace);
			continue;
		}
		const c = rootClass(s, scope);
		if (c?.hoistedIntoOwner) continue;
		if (c && !isConvertible(c)) {
			out.push(transformNested(sf, s, scope, f, ctx, o));
			continue;
		}
		if (c && isConvertible(c) && !emitted.has(c.target.key)) {
			log(o, {
				level: "info",
				event: "class.emit",
				message: `Emitting ${c.target.key}.`,
				fileName: sf.fileName,
				className: c.target.key,
				node: s,
				data: { members: c.members.length, targetScopes: c.targetScopes.size },
			});
			if (c.existingClass || !c.targetScopes.size) out.push(...c.preClassStatements, emitClass(sf, c, f, ctx, o), ...c.postClassStatements);
			emitted.add(c.target.key);
			if (ts.isVariableStatement(s)) {
				const ds = s.declarationList.declarations.filter((d) => !ts.isIdentifier(d.name) || d.name.text !== c.target.name);
				if (ds.length) out.push(f.updateVariableStatement(s, s.modifiers, f.updateVariableDeclarationList(s.declarationList, ds)));
			}
			continue;
		}
		if (!consumed.has(s)) out.push(transformNested(sf, s, scope, f, ctx, o));
	}
	const reloc = classesTargeting(scope).filter((c) => !c.existingClass);
	for (let i = reloc.length - 1; i >= 0; i--) out.unshift(emitClass(sf, reloc[i]!, f, ctx, o));
	if (reloc.length === 1) out.push(...reloc[0]!.postClassStatements, f.createReturnStatement(f.createIdentifier(reloc[0]!.target.name)));
	const emittedClassNames = new Set(
		out
			.filter((statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && !!statement.name)
			.map(statement => statement.name!.text),
	);
	const cleanedOutput = out.filter(statement => !isUninitializedNamespaceVariable(statement, emittedClassNames));
	return (
		ts.isSourceFile(node) ? f.updateSourceFile(node, cleanedOutput)
			: ts.isBlock(node) ? f.updateBlock(node, cleanedOutput)
				: f.updateModuleBlock(node, cleanedOutput)) as T;
}
export function createFixPrototypeTransformer(program?: ts.Program, options: FixPrototypeTransformerOptions = {}): ts.TransformerFactory<ts.SourceFile> {
	const o = { ...options, checker: options.checker ?? program?.getTypeChecker() };
	return (ctx) => (sf) => {
		log(o, { level: "info", event: "transform.start", message: `Starting transform for ${sf.fileName}.`, fileName: sf.fileName });
		const root = createScope(sf);
		processScope(sf, root, ctx.factory, o, ctx);
		const result = transformScope(sf, sf, root, ctx.factory, ctx, o);
		log(o, { level: "info", event: "transform.complete", message: `Completed transform for ${sf.fileName}.`, fileName: sf.fileName });
		return result;
	};
}
export const fixPrototypeTransformer = createFixPrototypeTransformer;
export default function createTransformer({ program, options }: { program?: ts.Program; options?: FixPrototypeTransformerOptions }): ts.TransformerFactory<ts.SourceFile> {
	return createFixPrototypeTransformer(program, {debug: false, ...options});
}
