import ts from "typescript";

type ScopeNode = ts.SourceFile | ts.Block | ts.ModuleBlock;
type ConstructorFunction = ts.FunctionDeclaration | ts.FunctionExpression;
type MethodKind = "method" | "get" | "set";

type TransformDiagnosticCode =
    | "AMBIGUOUS_IIFE_CLASS"
    | "DUPLICATE_CLASS_ROOT"
    | "MISSING_SUPER_CALL"
    | "UNSAFE_ARROW_FUNCTION";

export interface TransformDiagnostic {
    code: TransformDiagnosticCode;
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

export interface FixPrototypeTransformerOptions {
    onDiagnostic?: (diagnostic: TransformDiagnostic) => void;
    debug?: boolean;
    logger?: (entry: FixPrototypeLogEntry) => void;
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
    classCreateStatement?: ts.VariableStatement;
    constructorFunction?: ConstructorFunction;
    initializeMethod?: MethodInfo;
    baseClass?: ts.Expression;
    members: MemberInfo[];
    consumedStatements: Set<ts.Statement>;
    postClassStatements: ts.Statement[];
    convertible: boolean;
}

interface ScopeContext {
    parent?: ScopeContext;
    node: ScopeNode;
    classes: Map<string, ClassInfo>;
    childScopes: Map<ScopeNode, ScopeContext>;
    resolveParentClasses: boolean;
}

function log(
    options: FixPrototypeTransformerOptions,
    entry: FixPrototypeLogEntry,
): void {
    if (!options.debug && !options.logger) return;

    if (options.logger) {
        options.logger(entry);
        return;
    }

    const details = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
    const prefix = `[fixPrototype:${entry.event}]`;
    const fn = entry.level === "warn" ? console.warn : entry.level === "debug" ? console.debug : console.info;
    fn(`${prefix} ${entry.message}${details}`);
}

function nodeLocation(sourceFile: ts.SourceFile, node: ts.Node): Record<string, unknown> {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
    return { line: start.line + 1, column: start.character + 1, kind: ts.SyntaxKind[node.kind] };
}

function report(options: FixPrototypeTransformerOptions, diagnostic: TransformDiagnostic): void {
    options.onDiagnostic?.(diagnostic);
    log(options, {
        level: "warn",
        event: "diagnostic",
        message: diagnostic.message,
        className: diagnostic.className,
        node: diagnostic.node,
        data: { code: diagnostic.code },
    });
}

function createScope(
    node: ScopeNode,
    parent?: ScopeContext,
    resolveParentClasses = true,
): ScopeContext {
    return {
        parent,
        node,
        classes: new Map(),
        childScopes: new Map(),
        resolveParentClasses,
    };
}

function expressionPath(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
        const left = expressionPath(expression.expression);
        return left ? `${left}.${expression.name.text}` : undefined;
    }
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
        const left = expressionPath(expression.expression);
        return left ? `${left}.${expression.argumentExpression.text}` : undefined;
    }
    return undefined;
}

function targetName(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) return expression.argumentExpression.text;
    return undefined;
}

function createClassInfo(target: ClassTarget, root: ts.Statement, scope: ScopeContext): ClassInfo {
    return {
        target,
        root,
        definingScope: scope,
        targetScopes: new Set(),
        members: [],
        consumedStatements: new Set([root]),
        postClassStatements: [],
        convertible: true,
    };
}

function registerClass(scope: ScopeContext, cls: ClassInfo, options: FixPrototypeTransformerOptions): ClassInfo {
    const existing = scope.classes.get(cls.target.key);
    if (!existing) {
        scope.classes.set(cls.target.key, cls);
        log(options, {
            level: "debug",
            event: "class.register",
            message: `Registered class candidate ${cls.target.key}.`,
            className: cls.target.key,
            node: cls.root,
            data: { qualified: !!cls.target.assignmentTarget },
        });
        return cls;
    }
    if (existing.root === cls.root) return existing;
    existing.convertible = false;
    report(options, {
        code: "DUPLICATE_CLASS_ROOT",
        message: `Multiple class roots named ${cls.target.key} were found in the same scope.`,
        node: cls.root,
        className: cls.target.key,
    });
    return existing;
}

function resolveClass(scope: ScopeContext, key: string): ClassInfo | undefined {
    let current: ScopeContext | undefined = scope;
    let mayResolveParent = true;

    while (current) {
        const cls = current.classes.get(key);
        if (cls) return cls;

        mayResolveParent = mayResolveParent && current.resolveParentClasses;
        if (!mayResolveParent) return undefined;

        current = current.parent;
    }

    return undefined;
}

function unwrapParentheses<T extends ts.Expression>(expression: T): ts.Expression {
    let current: ts.Expression = expression;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
}

function isClassCreate(expression: ts.Expression): expression is ts.CallExpression {
    const value = unwrapParentheses(expression);
    return ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        ts.isIdentifier(value.expression.expression) &&
        value.expression.expression.text === "Class" &&
        value.expression.name.text === "create";
}

function detectDeclarationRoots(statement: ts.Statement, scope: ScopeContext, options: FixPrototypeTransformerOptions): void {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
        const target = { key: statement.name.text, name: statement.name.text };
        const cls = createClassInfo(target, statement, scope);
        cls.constructorFunction = statement;
        registerClass(scope, cls, options);
        return;
    }
    if (!ts.isVariableStatement(statement)) return;
    for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const name = declaration.name.text;
        if (isClassCreate(declaration.initializer)) {
            const cls = createClassInfo({ key: name, name }, statement, scope);
            cls.classCreateStatement = statement;
            registerClass(scope, cls, options);
        } else {
            const initializer = unwrapParentheses(declaration.initializer);
            if (ts.isFunctionExpression(initializer)) {
                const cls = createClassInfo({ key: name, name }, statement, scope);
                cls.constructorFunction = initializer;
                registerClass(scope, cls, options);
            }
        }
    }
}

function assignmentFromStatement(statement: ts.Statement): ts.BinaryExpression | undefined {
    return ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken ? statement.expression : undefined;
}

function containsPrototypeSegment(key: string): boolean {
    return key.split(".").includes("prototype");
}

function scopeUsesPrototype(scope: ScopeContext, key: string): boolean {
    for (const statement of scope.node.statements) {
        if (!ts.isExpressionStatement(statement)) continue;

        let found = false;
        const visit = (expression: ts.Expression): void => {
            if (found || !ts.isBinaryExpression(expression)) return;

            if (expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
                visit(expression.left);
                visit(expression.right);
                return;
            }

            if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
            const prototype = parsePrototypeLeft(expression.left);
            if (prototype?.key === key) found = true;
        };

        visit(statement.expression);
        if (found) return true;
    }

    return false;
}

function detectQualifiedRoots(statement: ts.Statement, scope: ScopeContext, options: FixPrototypeTransformerOptions): void {
    const assignment = assignmentFromStatement(statement);
    if (!assignment) return;
    const right = unwrapParentheses(assignment.right);
    if (!ts.isFunctionExpression(right) || ts.isIdentifier(assignment.left)) return;
    const key = expressionPath(assignment.left);
    const name = targetName(assignment.left);
    if (
        !key ||
        !name ||
        !key.includes(".") ||
        containsPrototypeSegment(key) ||
        !scopeUsesPrototype(scope, key)
    ) return;

    const cls = createClassInfo({ key, name, assignmentTarget: assignment.left }, statement, scope);
    log(options, {
        level: "debug",
        event: "class.qualified",
        message: `Qualified constructor ${key} has matching prototype usage.`,
        className: key,
        node: statement,
    });
    cls.constructorFunction = right;
    registerClass(scope, cls, options);
}

function cloneName(name: ts.PropertyName, factory: ts.NodeFactory): ts.PropertyName {
    if (ts.isIdentifier(name)) return factory.createIdentifier(name.text);
    if (ts.isPrivateIdentifier(name)) return factory.createPrivateIdentifier(name.text);
    if (ts.isStringLiteral(name)) return factory.createStringLiteral(name.text);
    if (ts.isNumericLiteral(name)) return factory.createNumericLiteral(name.text);
    if (ts.isBigIntLiteral(name)) return factory.createBigIntLiteral(name.text);
    if (ts.isComputedPropertyName(name)) return factory.createComputedPropertyName(name.expression);
    return factory.createStringLiteral(name.text);
}

function nameFromMemberAccess(expression: ts.Expression, factory: ts.NodeFactory): ts.PropertyName | undefined {
    if (ts.isPropertyAccessExpression(expression)) return factory.createIdentifier(expression.name.text);
    if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) return undefined;
    const argument = expression.argumentExpression;
    if (ts.isStringLiteral(argument)) return factory.createStringLiteral(argument.text);
    if (ts.isNumericLiteral(argument)) return factory.createNumericLiteral(argument.text);
    return factory.createComputedPropertyName(argument);
}

function propertyText(name: ts.PropertyName): string | undefined {
    return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function constStyle(name: ts.PropertyName): boolean {
    const text = propertyText(name);
    return !!text && text === text.toUpperCase();
}

function normalizeBody(fn: ts.FunctionExpression | ts.ArrowFunction, factory: ts.NodeFactory): ts.Block {
    return ts.isBlock(fn.body) ? fn.body : factory.createBlock([factory.createReturnStatement(fn.body)], true);
}

function arrowUsesLexicalBinding(fn: ts.ArrowFunction): boolean {
    let unsafe = false;
    const visit = (node: ts.Node): void => {
        if (unsafe) return;
        if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword ||
            (ts.isIdentifier(node) && node.text === "arguments") || ts.isMetaProperty(node)) {
            unsafe = true;
            return;
        }
        if (node !== fn && ts.isFunctionLike(node)) return;
        ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return unsafe;
}

function addMethod(cls: ClassInfo, method: MethodInfo): void {
    if (!method.isStatic && method.kind === "method" && propertyText(method.name) === "initialize") cls.initializeMethod = method;
    else cls.members.push(method);
}

function processObjectLiteral(cls: ClassInfo, statement: ts.Statement, object: ts.ObjectLiteralExpression, factory: ts.NodeFactory, options: FixPrototypeTransformerOptions): void {
    for (const member of object.properties) {
        if (ts.isSpreadAssignment(member)) continue;
        if (ts.isMethodDeclaration(member)) {
            addMethod(cls, {
                name: member.name, kind: "method", isStatic: false, parameters: member.parameters,
                body: member.body ?? factory.createBlock([], true), sourceStatement: statement, sourceNode: member
            });
        } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
            addMethod(cls, {
                name: member.name, kind: ts.isGetAccessorDeclaration(member) ? "get" : "set", isStatic: false,
                parameters: member.parameters, body: member.body ?? factory.createBlock([], true), sourceStatement: statement, sourceNode: member
            });
        } else if (ts.isPropertyAssignment(member)) {
            const value = member.initializer;
            if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
                if (ts.isArrowFunction(value) && arrowUsesLexicalBinding(value)) {
                    cls.members.push({ name: member.name, isStatic: false, constLike: false, initializer: value, sourceStatement: statement, sourceNode: member });
                    report(options, { code: "UNSAFE_ARROW_FUNCTION", message: "Preserved arrow-valued member to retain lexical bindings.", node: member, className: cls.target.key });
                } else addMethod(cls, {
                    name: member.name, kind: "method", isStatic: false, parameters: value.parameters,
                    body: normalizeBody(value, factory), sourceStatement: statement, sourceNode: member
                });
            } else cls.members.push({ name: member.name, isStatic: false, constLike: false, initializer: value, sourceStatement: statement, sourceNode: member });
        } else if (ts.isShorthandPropertyAssignment(member)) {
            cls.members.push({ name: member.name, isStatic: false, constLike: false, initializer: factory.createIdentifier(member.name.text), sourceStatement: statement, sourceNode: member });
        }
    }
}

function prototypeOwner(expression: ts.Expression): ts.Expression | undefined {
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === "prototype") return expression.expression;
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression) && expression.argumentExpression.text === "prototype") return expression.expression;
    return undefined;
}

function parsePrototypeLeft(expression: ts.Expression): { key: string; member?: ts.Expression } | undefined {
    const directOwner = prototypeOwner(expression);
    if (directOwner) {
        const key = expressionPath(directOwner);
        return key ? { key } : undefined;
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        const owner = prototypeOwner(expression.expression);
        const key = owner && expressionPath(owner);
        return key ? { key, member: expression } : undefined;
    }
    return undefined;
}

function parseInheritance(expression: ts.Expression): { baseClass?: ts.Expression; members?: ts.ObjectLiteralExpression } | undefined {
    const value = unwrapParentheses(expression);
    if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression) ||
        !ts.isIdentifier(value.expression.expression) || value.expression.expression.text !== "Object") return undefined;
    const method = value.expression.name.text;
    if (method === "create" && value.arguments.length === 1) {
        const owner = prototypeOwner(value.arguments[0]!);
        return owner ? { baseClass: owner } : undefined;
    }
    if ((method === "extend" || method === "extendsObject") && value.arguments.length) {
        return { baseClass: value.arguments[0], members: ts.isObjectLiteralExpression(value.arguments[1]) ? value.arguments[1] : undefined };
    }
    return undefined;
}

function addAssignedMember(cls: ClassInfo, statement: ts.Statement, name: ts.PropertyName, value: ts.Expression, isStatic: boolean,
    factory: ts.NodeFactory, options: FixPrototypeTransformerOptions): void {
    if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
        if (ts.isArrowFunction(value) && arrowUsesLexicalBinding(value)) {
            cls.members.push({ name, isStatic, constLike: isStatic && constStyle(name), initializer: value, sourceStatement: statement, sourceNode: statement });
            report(options, { code: "UNSAFE_ARROW_FUNCTION", message: "Preserved arrow-valued member to retain lexical bindings.", node: statement, className: cls.target.key });
        } else addMethod(cls, { name, kind: "method", isStatic, parameters: value.parameters, body: normalizeBody(value, factory), sourceStatement: statement, sourceNode: statement });
    } else cls.members.push({ name, isStatic, constLike: isStatic && constStyle(name), initializer: value, sourceStatement: statement, sourceNode: statement });
    cls.consumedStatements.add(statement);
}

function detectAssignment(statement: ts.Statement, assignment: ts.BinaryExpression, scope: ScopeContext, factory: ts.NodeFactory, options: FixPrototypeTransformerOptions): void {
    const qualifiedRootKey = expressionPath(assignment.left);
    if (qualifiedRootKey) {
        const root = resolveClass(scope, qualifiedRootKey);
        if (root?.root === statement && root.target.assignmentTarget) return;
    }

    const proto = parsePrototypeLeft(assignment.left);
    if (proto) {
        const cls = resolveClass(scope, proto.key);
        if (!cls) return;
        if (cls.definingScope !== scope) cls.targetScopes.add(scope);
        if (proto.member) {
            const name = nameFromMemberAccess(proto.member, factory);
            if (name) addAssignedMember(cls, statement, name, assignment.right, false, factory, options);
        } else if (ts.isObjectLiteralExpression(assignment.right)) {
            processObjectLiteral(cls, statement, assignment.right, factory, options);
            cls.consumedStatements.add(statement);
        } else {
            const inheritance = parseInheritance(assignment.right);
            if (inheritance) {
                cls.baseClass = inheritance.baseClass;
                if (inheritance.members) processObjectLiteral(cls, statement, inheritance.members, factory, options);
                cls.consumedStatements.add(statement);
            }
        }
        return;
    }

    if (!ts.isPropertyAccessExpression(assignment.left) && !ts.isElementAccessExpression(assignment.left)) return;
    const ownerKey = expressionPath(assignment.left.expression);
    const cls = ownerKey && resolveClass(scope, ownerKey);
    if (!cls) return;
    if (cls.definingScope !== scope) cls.targetScopes.add(scope);
    const name = nameFromMemberAccess(assignment.left, factory);
    if (name) addAssignedMember(cls, statement, name, assignment.right, true, factory, options);
}

function visitAssignments(statement: ts.Statement, expression: ts.Expression, scope: ScopeContext, factory: ts.NodeFactory, options: FixPrototypeTransformerOptions): void {
    if (!ts.isBinaryExpression(expression)) return;
    if (expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        visitAssignments(statement, expression.left, scope, factory, options);
        visitAssignments(statement, expression.right, scope, factory, options);
    } else if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) detectAssignment(statement, expression, scope, factory, options);
}

function detectFreeze(statement: ts.Statement, scope: ScopeContext): void {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression) ||
        call.expression.expression.text !== "Object" || call.expression.name.text !== "freeze") return;
    const argument = call.arguments[0];
    const owner = argument && prototypeOwner(argument);
    const key = owner && expressionPath(owner);
    const cls = key && resolveClass(scope, key);
    if (!cls) return;
    cls.postClassStatements.push(statement);
    cls.consumedStatements.add(statement);
}

function isImmediatelyInvokedFunction(node: ts.FunctionExpression | ts.ArrowFunction): boolean {
    let expression: ts.Expression = node;
    let parent = node.parent;

    while (parent && ts.isParenthesizedExpression(parent)) {
        expression = parent;
        parent = parent.parent;
    }

    return !!parent && ts.isCallExpression(parent) && parent.expression === expression;
}

function childCanResolveParentClasses(node: ScopeNode): boolean {
    if (!ts.isBlock(node)) return true;

    const parent = node.parent;
    if (
        !parent ||
        !(
            ts.isFunctionDeclaration(parent) ||
            ts.isFunctionExpression(parent) ||
            ts.isArrowFunction(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) ||
            ts.isConstructorDeclaration(parent)
        ) ||
        parent.body !== node
    ) return true;

    return (ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) &&
        isImmediatelyInvokedFunction(parent);
}

function processScope(node: ScopeNode, scope: ScopeContext, factory: ts.NodeFactory, options: FixPrototypeTransformerOptions): void {
    for (const statement of node.statements) detectDeclarationRoots(statement, scope, options);
    for (const statement of node.statements) detectQualifiedRoots(statement, scope, options);
    for (const statement of node.statements) {
        if (ts.isExpressionStatement(statement)) visitAssignments(statement, statement.expression, scope, factory, options);
        detectFreeze(statement, scope);
    }
    for (const statement of node.statements) {
        const visit = (child: ts.Node): void => {
            if (ts.isBlock(child) || ts.isModuleBlock(child)) {
                const childScope = createScope(
                    child,
                    scope,
                    childCanResolveParentClasses(child),
                );
                scope.childScopes.set(child, childScope);
                processScope(child, childScope, factory, options);
                return;
            }
            ts.forEachChild(child, visit);
        };
        visit(statement);
    }
}

function copyComments(sourceFile: ts.SourceFile, from: ts.Node, to: ts.Node): void {
    if (ts.getSyntheticLeadingComments(to)?.length || ts.getSyntheticTrailingComments(to)?.length) return;
    const text = sourceFile.getFullText();
    for (const range of ts.getLeadingCommentRanges(text, from.pos) ?? []) {
        const line = range.kind === ts.SyntaxKind.SingleLineCommentTrivia;
        ts.addSyntheticLeadingComment(to, range.kind, text.slice(range.pos + 2, range.end - (line ? 0 : 2)), true);
    }
}

function isMethod(member: MemberInfo): member is MethodInfo { return "kind" in member; }
function memberPosition(member: MemberInfo, sourceFile: ts.SourceFile): number { return member.sourceNode.getStart(sourceFile, false); }

function emitMethod(sourceFile: ts.SourceFile, method: MethodInfo, factory: ts.NodeFactory): ts.ClassElement {
    const modifiers = method.isStatic ? [factory.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined;
    let result: ts.ClassElement;
    if (method.kind === "get") result = factory.createGetAccessorDeclaration(modifiers, cloneName(method.name, factory), [], undefined, method.body);
    else if (method.kind === "set") result = factory.createSetAccessorDeclaration(modifiers, cloneName(method.name, factory), method.parameters, method.body);
    else result = factory.createMethodDeclaration(modifiers, undefined, cloneName(method.name, factory), undefined, undefined, method.parameters, undefined, method.body);
    copyComments(sourceFile, method.sourceNode, result);
    return result;
}

function emitProperty(sourceFile: ts.SourceFile, property: PropertyInfo, factory: ts.NodeFactory): ts.PropertyDeclaration {
    const modifiers = property.isStatic ? [factory.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined;
    let initializer = property.initializer;
    if (property.constLike && initializer) {
        if (/\.[cm]?jsx?$/i.test(sourceFile.fileName)) {
            const wrapped = ts.isParenthesizedExpression(initializer) ? initializer : factory.createParenthesizedExpression(initializer);
            initializer = ts.addSyntheticLeadingComment(wrapped, ts.SyntaxKind.MultiLineCommentTrivia, "* @type {const} ", false);
        } else initializer = factory.createAsExpression(initializer, factory.createTypeReferenceNode("const"));
    }
    const result = factory.createPropertyDeclaration(modifiers, cloneName(property.name, factory), undefined, undefined, initializer);
    copyComments(sourceFile, property.sourceNode, result);
    return result;
}

function hasSuper(statements: readonly ts.Statement[]): boolean {
    return statements.some(s => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.kind === ts.SyntaxKind.SuperKeyword);
}

function emitMembers(sourceFile: ts.SourceFile, cls: ClassInfo, factory: ts.NodeFactory, options: FixPrototypeTransformerOptions): ts.ClassElement[] {
    const result: ts.ClassElement[] = [];
    const parameters = cls.initializeMethod?.parameters ?? cls.constructorFunction?.parameters ?? [];
    const statements = [...(cls.constructorFunction?.body?.statements ?? [])];
    if (cls.baseClass && !hasSuper(statements)) {
        statements.unshift(factory.createExpressionStatement(factory.createCallExpression(factory.createSuper(), undefined, [])));
        report(options, { code: "MISSING_SUPER_CALL", message: `Inserted super() into ${cls.target.key}.`, node: cls.root, className: cls.target.key });
    }
    if (cls.classCreateStatement && !cls.members.some(m => !isMethod(m) && !m.isStatic && propertyText(m.name) === "type")) {
        statements.push(factory.createExpressionStatement(factory.createBinaryExpression(factory.createPropertyAccessExpression(factory.createThis(), "type"),
            factory.createToken(ts.SyntaxKind.EqualsToken), factory.createStringLiteral(cls.target.name))));
    }
    if (cls.initializeMethod) statements.push(...cls.initializeMethod.body.statements);
    if (parameters.length || statements.length) result.push(factory.createConstructorDeclaration(undefined, parameters, factory.createBlock(statements, true)));
    for (const member of [...cls.members].sort((a, b) => memberPosition(a, sourceFile) - memberPosition(b, sourceFile))) {
        result.push(isMethod(member) ? emitMethod(sourceFile, member, factory) : emitProperty(sourceFile, member, factory));
    }
    return result;
}

function heritage(cls: ClassInfo, factory: ts.NodeFactory): ts.HeritageClause[] | undefined {
    return cls.baseClass ? [factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword,
        [factory.createExpressionWithTypeArguments(cls.baseClass, undefined)])] : undefined;
}

function emitClassStatement(sourceFile: ts.SourceFile, cls: ClassInfo, factory: ts.NodeFactory, options: FixPrototypeTransformerOptions): ts.Statement {
    const members = emitMembers(sourceFile, cls, factory, options);
    if (cls.target.assignmentTarget) {
        const expression = factory.createClassExpression(undefined, factory.createIdentifier(cls.target.name), undefined, heritage(cls, factory), members);
        const result = factory.createExpressionStatement(factory.createBinaryExpression(cls.target.assignmentTarget,
            factory.createToken(ts.SyntaxKind.EqualsToken), expression));
        copyComments(sourceFile, cls.root, result);
        return result;
    }
    const result = factory.createClassDeclaration(undefined, cls.target.name, undefined, heritage(cls, factory), members);
    copyComments(sourceFile, cls.root, result);
    return result;
}

function isConvertible(cls: ClassInfo): boolean {
    return cls.convertible && (!!cls.classCreateStatement || !!cls.initializeMethod || !!cls.baseClass || cls.members.length > 0 ||
        cls.targetScopes.size > 0 || cls.postClassStatements.length > 0);
}

function classesTargeting(scope: ScopeContext): ClassInfo[] {
    const result: ClassInfo[] = [];
    let parent = scope.parent;
    while (parent) {
        for (const cls of parent.classes.values()) if (cls.targetScopes.has(scope) && isConvertible(cls)) result.push(cls);
        parent = parent.parent;
    }
    return result;
}

function rootClass(statement: ts.Statement, scope: ScopeContext): ClassInfo | undefined {
    for (const cls of scope.classes.values()) if (cls.root === statement) return cls;
    return undefined;
}

function preserveDeclarations(statement: ts.VariableStatement, cls: ClassInfo, factory: ts.NodeFactory): ts.VariableStatement | undefined {
    const declarations = statement.declarationList.declarations.filter(d => !ts.isIdentifier(d.name) || d.name.text !== cls.target.name);
    return declarations.length ? factory.updateVariableStatement(statement, statement.modifiers,
        factory.updateVariableDeclarationList(statement.declarationList, declarations)) : undefined;
}

function transformNested<T extends ts.Node>(sourceFile: ts.SourceFile, node: T, scope: ScopeContext, factory: ts.NodeFactory,
    context: ts.TransformationContext, options: FixPrototypeTransformerOptions): T {
    const visit = (child: ts.Node): ts.VisitResult<ts.Node> => {
        if (ts.isBlock(child) || ts.isModuleBlock(child)) {
            const childScope = scope.childScopes.get(child);
            if (childScope) return transformScope(sourceFile, child, childScope, factory, context, options);
        }
        return ts.visitEachChild(child, visit, context);
    };
    return ts.visitEachChild(node, visit, context) as T;
}

function rewriteIife(sourceFile: ts.SourceFile, statement: ts.Statement, scope: ScopeContext, factory: ts.NodeFactory,
    context: ts.TransformationContext, options: FixPrototypeTransformerOptions): ts.Statement {
    if (!ts.isExpressionStatement(statement)) return statement;
    const outer = statement.expression;
    const callCandidate = ts.isParenthesizedExpression(outer) ? outer.expression : outer;
    if (!ts.isCallExpression(callCandidate)) return statement;
    const callee = callCandidate.expression;
    const fnCandidate = ts.isParenthesizedExpression(callee) ? callee.expression : callee;
    if (!ts.isFunctionExpression(fnCandidate)) return statement;
    const childScope = scope.childScopes.get(fnCandidate.body);
    if (!childScope) return statement;
    const targets = classesTargeting(childScope);
    log(options, {
        level: "debug",
        event: "iife.inspect",
        message: `Inspected IIFE and found ${targets.length} cross-scope class target(s).`,
        fileName: sourceFile.fileName,
        scopeKind: childScope.node.kind,
        node: statement,
        data: { targets: targets.map(target => target.target.key), location: nodeLocation(sourceFile, statement) },
    });
    if (targets.length !== 1) {
        if (targets.length > 1) report(options, { code: "AMBIGUOUS_IIFE_CLASS", message: "IIFE targets multiple outer classes.", node: statement });
        return statement;
    }
    const body = transformScope(sourceFile, fnCandidate.body, childScope, factory, context, options);
    const fn = factory.updateFunctionExpression(fnCandidate, fnCandidate.modifiers, fnCandidate.asteriskToken, fnCandidate.name,
        fnCandidate.typeParameters, fnCandidate.parameters, fnCandidate.type, body);
    const newCallee = ts.isParenthesizedExpression(callee) ? factory.updateParenthesizedExpression(callee, fn) : fn;
    const call = factory.updateCallExpression(callCandidate, newCallee, callCandidate.typeArguments, callCandidate.arguments);
    const initializer = ts.isParenthesizedExpression(outer) ? factory.updateParenthesizedExpression(outer, call) : call;
    const target = targets[0]!;
    if (target.target.assignmentTarget) {
        return factory.createExpressionStatement(factory.createBinaryExpression(target.target.assignmentTarget,
            factory.createToken(ts.SyntaxKind.EqualsToken), initializer));
    }
    return factory.createVariableStatement(undefined, factory.createVariableDeclarationList([
        factory.createVariableDeclaration(target.target.name, undefined, undefined, initializer),
    ], ts.NodeFlags.Let));
}

function transformScope<T extends ScopeNode>(sourceFile: ts.SourceFile, node: T, scope: ScopeContext, factory: ts.NodeFactory,
    context: ts.TransformationContext, options: FixPrototypeTransformerOptions): T {
    const consumed = new Set<ts.Statement>();
    for (const cls of scope.classes.values()) if (isConvertible(cls)) for (const statement of cls.consumedStatements) consumed.add(statement);
    for (const cls of classesTargeting(scope)) for (const statement of cls.consumedStatements) if (node.statements.includes(statement)) consumed.add(statement);

    const output: ts.Statement[] = [];
    const emitted = new Set<string>();
    for (const statement of node.statements) {
        const cls = rootClass(statement, scope);
        if (cls && isConvertible(cls) && !emitted.has(cls.target.key)) {
            log(options, {
                level: "info",
                event: "class.emit",
                message: `Emitting ${cls.target.key} as ${cls.target.assignmentTarget ? "qualified class expression" : "class declaration"}.`,
                fileName: sourceFile.fileName,
                scopeKind: scope.node.kind,
                className: cls.target.key,
                node: statement,
                data: {
                    members: cls.members.length,
                    hasConstructor: !!cls.constructorFunction,
                    hasInitialize: !!cls.initializeMethod,
                    targetScopes: cls.targetScopes.size,
                    location: nodeLocation(sourceFile, statement),
                },
            });
            if (!cls.targetScopes.size) output.push(emitClassStatement(sourceFile, cls, factory, options), ...cls.postClassStatements);
            emitted.add(cls.target.key);
            if (ts.isVariableStatement(statement)) {
                const remainder = preserveDeclarations(statement, cls, factory);
                if (remainder) output.push(remainder);
            }
            continue;
        }
        if (!consumed.has(statement)) {
            const rewritten = rewriteIife(sourceFile, statement, scope, factory, context, options);
            output.push(transformNested(sourceFile, rewritten, scope, factory, context, options));
        }
    }

    const incoming = classesTargeting(scope);
    for (let i = incoming.length - 1; i >= 0; i--) {
        const cls = incoming[i]!;
        log(options, {
            level: "info",
            event: "class.emit-incoming",
            message: `Emitting cross-scope class ${cls.target.key}.`,
            fileName: sourceFile.fileName,
            scopeKind: scope.node.kind,
            className: cls.target.key,
            node: cls.root,
            data: { location: nodeLocation(sourceFile, cls.root) },
        });
        output.unshift(emitClassStatement(sourceFile, cls, factory, options));
    }
    if (incoming.length === 1) {
        const cls = incoming[0]!;
        output.push(...cls.postClassStatements, factory.createReturnStatement(factory.createIdentifier(cls.target.name)));
    }

    if (ts.isSourceFile(node)) return factory.updateSourceFile(node, output) as T;
    if (ts.isBlock(node)) return factory.updateBlock(node, output) as T;
    return factory.updateModuleBlock(node, output) as T;
}

export function createFixPrototypeTransformer(
    _program?: ts.Program,
    options: FixPrototypeTransformerOptions = { debug: true },
): ts.TransformerFactory<ts.SourceFile> {
    return context => sourceFile => {
        log(options, {
            level: "info",
            event: "transform.start",
            message: `Starting prototype-to-class transform for ${sourceFile.fileName}.`,
            fileName: sourceFile.fileName,
        });

        const root = createScope(sourceFile);
        processScope(sourceFile, root, context.factory, options);

        const discovered = [...root.classes.values()].map(cls => ({
            key: cls.target.key,
            convertible: isConvertible(cls),
            members: cls.members.length,
            qualified: !!cls.target.assignmentTarget,
        }));
        log(options, {
            level: "debug",
            event: "transform.discovery",
            message: `Root discovery found ${discovered.length} class candidate(s).`,
            fileName: sourceFile.fileName,
            data: { classes: discovered },
        });

        const result = transformScope(sourceFile, sourceFile, root, context.factory, context, options);
        log(options, {
            level: "info",
            event: "transform.complete",
            message: `Completed prototype-to-class transform for ${sourceFile.fileName}.`,
            fileName: sourceFile.fileName,
        });
        return result;
    };
}

export const fixPrototypeTransformer = createFixPrototypeTransformer;

export default function createTransformer({ program, options }: {
    program?: ts.Program;
    options?: FixPrototypeTransformerOptions;
}): ts.TransformerFactory<ts.SourceFile> {
    return createFixPrototypeTransformer(program, options);
}
