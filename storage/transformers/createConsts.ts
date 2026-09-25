import ts from "typescript";

import {
	isAsConstExpression,
	TSgetNonParenthesizedParent,
	TSgetOutermostParenthesizedExpression,
	TSisConstVariableDeclaration,
} from "./utils";

export interface CreateConstsOptions {
	/**
	 * Add const assertions to nonempty object literals.
	 *
	 * @default true
	 */
	readonly includeObjectLiterals?: boolean;

	/**
	 * Add const assertions to nonempty array literals.
	 *
	 * @default true
	 */
	readonly includeArrayLiterals?: boolean;

	/**
	 * Add const assertions to nonempty string literals.
	 *
	 * @default true
	 */
	readonly includeStringLiterals?: boolean;

	/**
	 * Add const assertions to nonempty template literals that contain
	 * no substitutions.
	 *
	 * Tagged templates and template expressions containing substitutions
	 * are deliberately excluded.
	 *
	 * @default true
	 */
	readonly includeNoSubstitutionTemplates?: boolean;

	/**
	 * Transform expressions returned directly from a function.
	 *
	 * @default true
	 */
	readonly includeReturnExpressions?: boolean;

	/**
	 * Transform initializers of const variable declarations.
	 *
	 * @default true
	 */
	readonly includeConstVariableInitializers?: boolean;

	/**
	 * Transform initializers of let and var variable declarations.
	 *
	 * Enabling this can introduce type errors if the variable is later
	 * assigned a different value.
	 *
	 * @default false
	 */
	readonly includeMutableVariableInitializers?: boolean;

	/**
	 * Transform the right-hand side of simple assignment expressions.
	 *
	 * Enabling this can affect contextual typing and subsequent assignments.
	 *
	 * @default false
	 */
	readonly includeAssignmentExpressions?: boolean;

	/**
	 * Log every conversion.
	 *
	 * @default false
	 */
	readonly logConversions?: boolean;

	/**
	 * Log node transformation errors.
	 *
	 * @default true
	 */
	readonly logErrors?: boolean;
}

interface ResolvedCreateConstsOptions {
	readonly includeObjectLiterals: boolean;
	readonly includeArrayLiterals: boolean;
	readonly includeStringLiterals: boolean;
	readonly includeNoSubstitutionTemplates: boolean;
	readonly includeReturnExpressions: boolean;
	readonly includeConstVariableInitializers: boolean;
	readonly includeMutableVariableInitializers: boolean;
	readonly includeAssignmentExpressions: boolean;
	readonly logConversions: boolean;
	readonly logErrors: boolean;
}

interface TransformerPluginContext {
	readonly program: ts.Program;
}

type ConstAssertionCandidate =
	| ts.ObjectLiteralExpression
	| ts.ArrayLiteralExpression
	| ts.StringLiteral
	| ts.NoSubstitutionTemplateLiteral;

const DEFAULT_OPTIONS: ResolvedCreateConstsOptions = {
	includeObjectLiterals: true,
	includeArrayLiterals: true,
	includeStringLiterals: true,
	includeNoSubstitutionTemplates: true,
	includeReturnExpressions: true,
	includeConstVariableInitializers: true,
	includeMutableVariableInitializers: false,
	includeAssignmentExpressions: false,
	logConversions: false,
	logErrors: true,
};

/**
 * Creates a transformer that adds const assertions to selected literal
 * expressions.
 *
 * The default configuration is conservative. It transforms direct return
 * expressions and initializers of const variable declarations. It does not
 * transform mutable variable initializers or assignment expressions unless
 * those options are explicitly enabled.
 */
export function createConsts(
	program: ts.Program,
	options: CreateConstsOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
	const resolvedOptions: ResolvedCreateConstsOptions = {
		...DEFAULT_OPTIONS,
		...options,
	};

	/*
	 * Keep the program parameter in the public API for future type-checker
	 * analysis and to preserve transformer-plugin compatibility.
	 */
	void program;

	return (context) => {
		const { factory } = context;

		return (sourceFile) => {
			const visitor: ts.Visitor = (node) => {
				try {
					/*
					 * Const assertions are applied before visiting the
					 * candidate's children.
					 *
					 * This avoids redundant results such as adding an
					 * assertion to an array nested inside an object that
					 * will itself receive a const assertion.
					 */
					if (
						isConstAssertionCandidate(
							node,
							resolvedOptions,
						) &&
						shouldAddConstAssertion(
							node,
							resolvedOptions,
						)
					) {
						const replacement =
							isJavaScriptSourceFile(sourceFile)
								? createJavaScriptConstAssertion(
										node,
										factory,
									)
								: createTypeScriptConstAssertion(
										node,
										factory,
									);

						if (resolvedOptions.logConversions) {
							logConstConversion(
								sourceFile,
								node,
							);
						}

						return replacement;
					}

					return ts.visitEachChild(
						node,
						visitor,
						context,
					);
				} catch (error: unknown) {
					if (resolvedOptions.logErrors) {
						logTransformationError(
							sourceFile,
							node,
							error,
						);
					}

					return node;
				}
			};

			return ts.visitEachChild(
				sourceFile,
				visitor,
				context,
			);
		};
	};
}

/**
 * Checks whether a node is one of the literal kinds supported by this
 * transformer.
 */
function isConstAssertionCandidate(
	node: ts.Node,
	options: ResolvedCreateConstsOptions,
): node is ConstAssertionCandidate {
	if (
		options.includeObjectLiterals &&
		ts.isObjectLiteralExpression(node)
	) {
		return node.properties.length > 0;
	}

	if (
		options.includeArrayLiterals &&
		ts.isArrayLiteralExpression(node)
	) {
		return node.elements.length > 0;
	}

	if (
		options.includeStringLiterals &&
		ts.isStringLiteral(node)
	) {
		return node.text.length > 0;
	}

	if (
		options.includeNoSubstitutionTemplates &&
		ts.isNoSubstitutionTemplateLiteral(node)
	) {
		return node.text.length > 0;
	}

	return false;
}

/**
 * Determines whether an eligible expression occurs in an enabled context.
 */
function shouldAddConstAssertion(
	expression: ConstAssertionCandidate,
	options: ResolvedCreateConstsOptions,
): boolean {
	if (isAsConstExpression(expression)) {
		return false;
	}

	if (isElementAccessArgument(expression)) {
		return false;
	}

	const expressionRoot =
		TSgetOutermostParenthesizedExpression(
			expression,
		);

	const parent =
		TSgetNonParenthesizedParent(expression);

	if (!parent) {
		return false;
	}

	if (
		options.includeReturnExpressions &&
		ts.isReturnStatement(parent) &&
		parent.expression === expressionRoot
	) {
		return true;
	}

	if (
		ts.isVariableDeclaration(parent) &&
		parent.initializer === expressionRoot
	) {
		if (TSisConstVariableDeclaration(parent)) {
			return options.includeConstVariableInitializers;
		}

		return options.includeMutableVariableInitializers;
	}

	if (
		options.includeAssignmentExpressions &&
		isSimpleAssignmentRightSide(
			parent,
			expressionRoot,
		)
	) {
		return true;
	}

	return false;
}

/**
 * Checks for a simple equals assignment whose right-hand side is the
 * candidate expression.
 */
function isSimpleAssignmentRightSide(
	node: ts.Node,
	expression: ts.Expression,
): node is ts.BinaryExpression {
	return (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind ===
			ts.SyntaxKind.EqualsToken &&
		node.right === expression
	);
}

/**
 * Rejects expressions used as the argument of an element-access expression.
 *
 * Examples include string literal property lookups and parenthesized
 * property lookup expressions.
 */
function isElementAccessArgument(
	node: ts.Node,
): boolean {
	let current = node;

	while (
		current.parent &&
		ts.isParenthesizedExpression(current.parent)
	) {
		current = current.parent;
	}

	const parent = current.parent;

	return (
		parent !== undefined &&
		ts.isElementAccessExpression(parent) &&
		parent.argumentExpression === current
	);
}

/**
 * Creates a TypeScript const assertion.
 */
function createTypeScriptConstAssertion(
	expression: ConstAssertionCandidate,
	factory: ts.NodeFactory,
): ts.AsExpression {
	const constType =
		factory.createTypeReferenceNode(
			factory.createIdentifier("const"),
			undefined,
		);

	const replacement =
		factory.createAsExpression(
			expression,
			constType,
		);

	return preserveNodeMetadata(
		replacement,
		expression,
	);
}

/**
 * Creates a JavaScript JSDoc const assertion.
 *
 * The emitted form is a parenthesized expression with a synthetic
 * JSDoc-style const type comment.
 */
function createJavaScriptConstAssertion(
	expression: ConstAssertionCandidate,
	factory: ts.NodeFactory,
): ts.ParenthesizedExpression {
	const replacement =
		factory.createParenthesizedExpression(
			expression,
		);

	preserveNodeMetadata(
		replacement,
		expression,
	);

	ts.addSyntheticLeadingComment(
		replacement,
		ts.SyntaxKind.MultiLineCommentTrivia,
		"* @type {const} ",
		false,
	);

	return replacement;
}

/**
 * Associates a synthesized replacement with the original parsed node.
 */
function preserveNodeMetadata<
	TNode extends ts.Node,
>(
	replacement: TNode,
	original: ts.Node,
): TNode {
	ts.setOriginalNode(
		replacement,
		original,
	);

	ts.setTextRange(
		replacement,
		original,
	);

	return replacement;
}

/**
 * Determines whether the source file contains JavaScript or JSX.
 */
function isJavaScriptSourceFile(
	sourceFile: ts.SourceFile,
): boolean {
	return (
		sourceFile.scriptKind === ts.ScriptKind.JS ||
		sourceFile.scriptKind === ts.ScriptKind.JSX
	);
}

function logConstConversion(
	sourceFile: ts.SourceFile,
	node: ConstAssertionCandidate,
): void {
	const parentKind = node.parent
		? ts.SyntaxKind[node.parent.kind]
		: "Unknown";

	console.info(
		[
			"Converting expression to const assertion",
			`kind=${ts.SyntaxKind[node.kind]}`,
			`parent=${parentKind}`,
			`file=${sourceFile.fileName}`,
			`position=${getNodePosition(sourceFile, node)}`,
		].join(" | "),
	);
}

function logTransformationError(
	sourceFile: ts.SourceFile,
	node: ts.Node,
	error: unknown,
): void {
	console.error(
		[
			"Unable to transform node",
			`kind=${ts.SyntaxKind[node.kind]}`,
			`file=${sourceFile.fileName}`,
			`position=${getNodePosition(sourceFile, node)}`,
		].join(" | "),
		error,
	);
}

function getNodePosition(
	sourceFile: ts.SourceFile,
	node: ts.Node,
): string {
	try {
		return String(
			node.getStart(sourceFile, false),
		);
	} catch {
		return "unknown";
	}
}

/**
 * Transformer-plugin entry point.
 */
export default function createConstsPlugin(
	{ program }: TransformerPluginContext,
	options: CreateConstsOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
	return createConsts(
		program,
		options,
	);
}