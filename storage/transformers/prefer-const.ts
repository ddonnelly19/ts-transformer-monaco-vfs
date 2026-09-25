import ts from "typescript";

export interface PreferConstOptions {
    /**
     * Convert `var` declarations in addition to `let`.
     *
     * Disabled by default because changing `var` to `const` can alter:
     * - function scope
     * - block scope
     * - hoisting
     * - global-object behavior
     */
    includeVarDeclarations?: boolean;

    /**
     * Split statements containing both const-eligible and modified bindings.
     *
     * Input:
     *     let unchanged = 1, modified = 2;
     *
     * Output:
     *     const unchanged = 1;
     *     let modified = 2;
     *
     * Default: true
     */
    splitMixedDeclarations?: boolean;

    /**
     * Include JavaScript and JSX source files.
     *
     * Default: false
     */
    includeJavaScriptFiles?: boolean;

    /**
     * Include declaration files.
     *
     * Default: false
     */
    includeDeclarationFiles?: boolean;

    /**
     * Optional diagnostic logger.
     */
    logger?: (message: string) => void;
}

export interface PreferConstTransformResult {
    transformed: ts.TransformationResult<ts.SourceFile>;
    sourceFile: ts.SourceFile;
    convertedStatements: number;
    convertedDeclarations: number;
    skippedDeclarations: number;
}

interface TransformStatistics {
    convertedStatements: number;
    convertedDeclarations: number;
    skippedDeclarations: number;
}

interface DeclarationAnalysis {
    declaration: ts.VariableDeclaration;
    bindingSymbols: readonly ts.Symbol[];
    canBecomeConst: boolean;
    reason?: string;
}

interface SourceFileAnalysis {
    declarations: ReadonlyMap<ts.VariableDeclaration, DeclarationAnalysis>;
}

interface DeclarationGroup {
    flags: ts.NodeFlags;
    declarations: ts.VariableDeclaration[];
}

interface BindingIdentifier {
    identifier: ts.Identifier;
    symbol: ts.Symbol;
}

const defaultOptions: Required<
    Omit<PreferConstOptions, "logger">
> = {
    includeVarDeclarations: false,
    splitMixedDeclarations: true,
    includeJavaScriptFiles: false,
    includeDeclarationFiles: false,
};

/**
 * Creates a standard TypeScript transformer factory.
 *
 * Usage:
 *
 *     const transformer = createPreferConstTransformer(program);
 *
 *     program.emit(
 *         undefined,
 *         undefined,
 *         undefined,
 *         false,
 *         {
 *             before: [transformer],
 *         },
 *     );
 */
export function createPreferConstTransformer(
    program: ts.Program,
    options: PreferConstOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
    const normalizedOptions = normalizeOptions(options);

    return createTransformerFactory(
        program,
        normalizedOptions,
    );
}

/**
 * Transforms a single source file and returns statistics alongside the
 * TransformationResult.
 *
 * The caller must dispose the returned transformation result.
 */
export function transformPreferConst(
    program: ts.Program,
    sourceFile: ts.SourceFile,
    options: PreferConstOptions = {},
): PreferConstTransformResult {
    const normalizedOptions =
        normalizeOptions(options);

    const programSourceFile =
        program.getSourceFile(sourceFile.fileName);

    if (programSourceFile !== sourceFile) {
        throw new Error(
            `The supplied SourceFile "${sourceFile.fileName}" is not the ` +
            `same SourceFile instance owned by the supplied Program. ` +
            `Use program.getSourceFile(fileName) instead of reparsing ` +
            `the source text with ts.createSourceFile().`,
        );
    }

    const statistics: TransformStatistics = {
        convertedStatements: 0,
        convertedDeclarations: 0,
        skippedDeclarations: 0,
    };

    const transformer = createTransformerFactory(
        program,
        normalizedOptions,
        statistics,
    );

    const transformed = ts.transform(
        sourceFile,
        [transformer],
    );

    return {
        transformed,
        sourceFile: transformed.transformed[0]!,
        convertedStatements:
            statistics.convertedStatements,
        convertedDeclarations:
            statistics.convertedDeclarations,
        skippedDeclarations:
            statistics.skippedDeclarations,
    };
}

/**
 * Prints the transformed source file.
 */
export function printTransformedSourceFile(
    sourceFile: ts.SourceFile,
    printer: ts.Printer = ts.createPrinter({
        newLine: ts.NewLineKind.LineFeed,
    }),
): string {
    return printer.printFile(sourceFile);
}

function createTransformerFactory(
    program: ts.Program,
    options: NormalizedPreferConstOptions,
    externalStatistics?: TransformStatistics,
): ts.TransformerFactory<ts.SourceFile> {
    const checker = program.getTypeChecker();

    return (context) => {
        const factory = context.factory;

        return (sourceFile) => {
            if (!shouldTransformSourceFile(sourceFile, options)) {
                options.logger(
                    `Skipping source file: ${sourceFile.fileName}`,
                );

                return sourceFile;
            }

            const programSourceFile =
                program.getSourceFile(sourceFile.fileName);

            if (!programSourceFile) {
                options.logger(
                    `Skipping ${sourceFile.fileName}: the source file is ` +
                    `not part of the supplied TypeScript Program.`,
                );

                return sourceFile;
            }

            /*
             * The TypeChecker is bound to the Program's original SourceFile.
             * Never analyze a cloned, reparsed, or previously transformed
             * SourceFile with this checker.
             */
            if (programSourceFile !== sourceFile) {
                options.logger(
                    `Skipping ${sourceFile.fileName}: the transformer received ` +
                    `a different SourceFile instance than the one owned by ` +
                    `the supplied TypeScript Program.`,
                );

                return sourceFile;
            }

            const statistics: TransformStatistics =
                externalStatistics ?? {
                    convertedStatements: 0,
                    convertedDeclarations: 0,
                    skippedDeclarations: 0,
                };

            const analysis = analyzeSourceFile(
                sourceFile,
                checker,
                options,
            );

            const visitor: ts.Visitor = (node) => {
                if (ts.isVariableStatement(node)) {
                    return transformVariableStatement(
                        node,
                        analysis,
                        factory,
                        options,
                        statistics,
                    );
                }

                if (ts.isForStatement(node)) {
                    return transformForStatement(
                        node,
                        analysis,
                        factory,
                        context,
                        visitor,
                        options,
                        statistics,
                    );
                }

                if (ts.isForInStatement(node)) {
                    return transformForInStatement(
                        node,
                        analysis,
                        factory,
                        context,
                        visitor,
                        options,
                        statistics,
                    );
                }

                if (ts.isForOfStatement(node)) {
                    return transformForOfStatement(
                        node,
                        analysis,
                        factory,
                        context,
                        visitor,
                        options,
                        statistics,
                    );
                }

                return ts.visitEachChild(
                    node,
                    visitor,
                    context,
                );
            };

            return ts.visitNode(
                sourceFile,
                visitor,
                ts.isSourceFile,
            )!;
        };
    };
}

function getBindingIdentifiersSafe(
    bindingName: ts.BindingName,
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
    options: NormalizedPreferConstOptions,
): BindingIdentifier[] {
    const result: BindingIdentifier[] = [];

    visitBindingName(bindingName);

    return result;

    function visitBindingName(
        name: ts.BindingName,
    ): void {
        if (ts.isIdentifier(name)) {
            const symbol = getSymbolAtLocationSafe(
                name,
                checker,
                sourceFile,
                options,
            );

            if (symbol) {
                result.push({
                    identifier: name,
                    symbol,
                });
            }

            return;
        }

        for (const element of name.elements) {
            if (ts.isOmittedExpression(element)) {
                continue;
            }

            visitBindingName(element.name);
        }
    }
}

function getSymbolAtLocationSafe(
    node: ts.Identifier,
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
    options: NormalizedPreferConstOptions,
): ts.Symbol | undefined {
    /*
     * Nodes created by a transformer commonly have negative positions and
     * are not bound into the Program.
     */
    if (
        node.pos < 0 ||
        node.end < 0 ||
        node.getSourceFile() !== sourceFile
    ) {
        return undefined;
    }

    try {
        const symbol =
            checker.getSymbolAtLocation(node);

        return getCanonicalSymbolSafe(
            symbol,
            checker,
        );
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : String(error);

        options.logger(
            `Unable to resolve symbol for "${node.text}" at ` +
            `${formatLocation(node, sourceFile)}: ${message}`,
        );

        return undefined;
    }
}

function getCanonicalSymbolSafe(
    symbol: ts.Symbol | undefined,
    checker: ts.TypeChecker,
): ts.Symbol | undefined {
    if (!symbol) {
        return undefined;
    }

    /*
     * Local variables are not aliases. Resolving aliases is only needed
     * for import/export alias symbols.
     */
    if (
        (symbol.flags & ts.SymbolFlags.Alias) === 0
    ) {
        return symbol;
    }

    try {
        return checker.getAliasedSymbol(symbol);
    } catch {
        return symbol;
    }
}

function isBindingDeclarationIdentifier(
    identifier: ts.Identifier,
): boolean {
    let current: ts.Node = identifier;

    while (current.parent) {
        const parent = current.parent;

        if (
            ts.isObjectBindingPattern(parent) ||
            ts.isArrayBindingPattern(parent)
        ) {
            current = parent;
            continue;
        }

        if (ts.isBindingElement(parent)) {
            /*
             * In:
             *
             *     const { source: target } = value;
             *
             * "target" is the binding name and "source" is a property name.
             */
            if (
                parent.name === current ||
                isNodeWithin(
                    identifier,
                    parent.name,
                )
            ) {
                current = parent;
                continue;
            }

            return false;
        }

        if (
            ts.isVariableDeclaration(parent) &&
            (
                parent.name === current ||
                isNodeWithin(
                    identifier,
                    parent.name,
                )
            )
        ) {
            return true;
        }

        if (
            ts.isParameter(parent) &&
            (
                parent.name === current ||
                isNodeWithin(
                    identifier,
                    parent.name,
                )
            )
        ) {
            return true;
        }

        return false;
    }

    return false;
}

function analyzeSourceFile(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    options: NormalizedPreferConstOptions,
): SourceFileAnalysis {
    const candidateDeclarations: ts.VariableDeclaration[] = [];

    const declarationBindings = new Map<
        ts.VariableDeclaration,
        BindingIdentifier[]
    >();

    const candidateSymbols = new Set<ts.Symbol>();

    /*
     * Avoid invoking the checker for every identifier in the file.
     * Only identifiers with these names can possibly resolve to one of
     * the candidate symbols.
     */
    const candidateNames = new Set<string>();

    const modifiedSymbols = new Set<ts.Symbol>();

    collectCandidateDeclarations(sourceFile);

    for (const declaration of candidateDeclarations) {
        const bindings = getBindingIdentifiersSafe(
            declaration.name,
            checker,
            sourceFile,
            options,
        );

        declarationBindings.set(
            declaration,
            bindings,
        );

        for (const binding of bindings) {
            candidateSymbols.add(binding.symbol);
            candidateNames.add(binding.identifier.text);
        }
    }

    scanForWrites(sourceFile);

    const analyses = new Map<
        ts.VariableDeclaration,
        DeclarationAnalysis
    >();

    for (const declaration of candidateDeclarations) {
        const bindings =
            declarationBindings.get(declaration) ?? [];

        const declarationList = declaration.parent;
        const declarationOwner = declarationList.parent;

        const isForInOrOf =
            ts.isForInStatement(declarationOwner) ||
            ts.isForOfStatement(declarationOwner);

        if (!declaration.initializer && !isForInOrOf) {
            analyses.set(declaration, {
                declaration,
                bindingSymbols: bindings.map(
                    ({ symbol }) => symbol,
                ),
                canBecomeConst: false,
                reason: "Declaration has no initializer.",
            });

            continue;
        }

        if (bindings.length === 0) {
            analyses.set(declaration, {
                declaration,
                bindingSymbols: [],
                canBecomeConst: false,
                reason:
                    "No binding symbols could be resolved safely.",
            });

            continue;
        }

        const modifiedBinding = bindings.find(
            ({ symbol }) => modifiedSymbols.has(symbol),
        );

        if (modifiedBinding) {
            analyses.set(declaration, {
                declaration,
                bindingSymbols: bindings.map(
                    ({ symbol }) => symbol,
                ),
                canBecomeConst: false,
                reason:
                    `"${modifiedBinding.identifier.text}" is reassigned.`,
            });

            continue;
        }

        analyses.set(declaration, {
            declaration,
            bindingSymbols: bindings.map(
                ({ symbol }) => symbol,
            ),
            canBecomeConst: true,
        });
    }

    return {
        declarations: analyses,
    };

    function collectCandidateDeclarations(
        node: ts.Node,
    ): void {
        if (
            ts.isVariableDeclarationList(node) &&
            isSupportedDeclarationList(node, options)
        ) {
            candidateDeclarations.push(
                ...node.declarations,
            );
        }

        ts.forEachChild(
            node,
            collectCandidateDeclarations,
        );
    }

    function scanForWrites(node: ts.Node): void {
        if (
            ts.isIdentifier(node) &&
            candidateNames.has(node.text) &&
            !isBindingDeclarationIdentifier(node) &&
            isWriteReference(node)
        ) {
            const symbol = getSymbolAtLocationSafe(
                node,
                checker,
                sourceFile,
                options,
            );

            if (
                symbol &&
                candidateSymbols.has(symbol)
            ) {
                modifiedSymbols.add(symbol);
            }
        }

        ts.forEachChild(node, scanForWrites);
    }
}

function transformVariableStatement(
    statement: ts.VariableStatement,
    analysis: SourceFileAnalysis,
    factory: ts.NodeFactory,
    options: NormalizedPreferConstOptions,
    statistics: TransformStatistics,
): ts.VisitResult<ts.Statement> {
    const declarationList = statement.declarationList;

    if (!isSupportedDeclarationList(declarationList, options)) {
        return statement;
    }

    const declarationAnalyses = declarationList.declarations.map(
        (declaration) => analysis.declarations.get(declaration),
    );

    const convertibleCount = declarationAnalyses.filter(
        (entry) => entry?.canBecomeConst === true,
    ).length;

    const skippedCount =
        declarationList.declarations.length - convertibleCount;

    if (convertibleCount === 0) {
        statistics.skippedDeclarations += skippedCount;

        logSkippedDeclarations(
            declarationAnalyses,
            statement.getSourceFile(),
            options,
        );

        return statement;
    }

    if (skippedCount === 0) {
        statistics.convertedStatements++;
        statistics.convertedDeclarations += convertibleCount;

        const constDeclarationList =
            factory.createVariableDeclarationList(
                declarationList.declarations,
                ts.NodeFlags.Const,
            );

        ts.setOriginalNode(
            constDeclarationList,
            declarationList,
        );

        ts.setTextRange(
            constDeclarationList,
            declarationList,
        );

        const updatedStatement =
            factory.updateVariableStatement(
                statement,
                statement.modifiers,
                constDeclarationList,
            );

        options.logger(
            `Converted variable statement with ` +
            `${declarationList.declarations
                .map((d) => d.name.getText(statement.getSourceFile()))
                .join(", ")} at ` +
            `${formatLocation(statement)} to const.`,
        );

        return updatedStatement;
    }

    if (!options.splitMixedDeclarations) {
        statistics.skippedDeclarations +=
            declarationList.declarations.length;

        options.logger(
            `Skipped mixed declaration at ${formatLocation(statement)} ` +
            `because splitMixedDeclarations is disabled.`,
        );

        return statement;
    }

    statistics.convertedStatements++;
    statistics.convertedDeclarations += convertibleCount;
    statistics.skippedDeclarations += skippedCount;

    const groups = groupDeclarations(
        declarationList,
        analysis,
    );

    const replacementStatements = groups.map(
        (group, index) => {
            const updatedList =
                factory.createVariableDeclarationList(
                    group.declarations,
                    group.flags,
                );

            const updatedStatement =
                factory.createVariableStatement(
                    index === 0
                        ? statement.modifiers
                        : undefined,
                    updatedList,
                );

            ts.setTextRange(updatedStatement, statement);
            ts.setOriginalNode(updatedStatement, statement);

            if (index === 0) {
                copySyntheticComments(
                    statement,
                    updatedStatement,
                );
            }

            return updatedStatement;
        },
    );

    options.logger(
        `Split mixed declaration at ${formatLocation(statement)} and ` +
        `converted ${convertibleCount} declaration(s) to const.`,
    );

    return replacementStatements;
}

function transformForStatement(
    statement: ts.ForStatement,
    analysis: SourceFileAnalysis,
    factory: ts.NodeFactory,
    context: ts.TransformationContext,
    visitor: ts.Visitor,
    options: NormalizedPreferConstOptions,
    statistics: TransformStatistics,
): ts.ForStatement {
    const initializer = statement.initializer;

    let updatedInitializer:
        | ts.ForInitializer
        | undefined = initializer;

    if (
        initializer &&
        ts.isVariableDeclarationList(initializer)
    ) {
        updatedInitializer = transformLoopDeclarationList(
            initializer,
            analysis,
            factory,
            options,
            statistics,
        );
    } else if (initializer) {
        updatedInitializer = ts.visitNode(
            initializer,
            visitor,
            ts.isExpression,
        );
    }

    return factory.updateForStatement(
        statement,
        updatedInitializer,
        ts.visitNode(
            statement.condition,
            visitor,
            ts.isExpression,
        ),
        ts.visitNode(
            statement.incrementor,
            visitor,
            ts.isExpression,
        ),
        ts.visitNode(
            statement.statement,
            visitor,
            ts.isStatement,
        ) || statement.statement
    );
}

function transformForInStatement(
    statement: ts.ForInStatement,
    analysis: SourceFileAnalysis,
    factory: ts.NodeFactory,
    context: ts.TransformationContext,
    visitor: ts.Visitor,
    options: NormalizedPreferConstOptions,
    statistics: TransformStatistics,
): ts.ForInStatement {
    void context;

    const initializer = ts.isVariableDeclarationList(
        statement.initializer,
    )
        ? transformLoopDeclarationList(
            statement.initializer,
            analysis,
            factory,
            options,
            statistics,
        )
        : ts.visitNode(
            statement.initializer,
            visitor,
            ts.isExpression,
        );

    return factory.updateForInStatement(
        statement,
        initializer!,
        ts.visitNode(
            statement.expression,
            visitor,
            ts.isExpression,
        ) || statement.expression,
        ts.visitNode(
            statement.statement,
            visitor,
            ts.isStatement,
        ) || statement.statement,
    );
}

function transformForOfStatement(
    statement: ts.ForOfStatement,
    analysis: SourceFileAnalysis,
    factory: ts.NodeFactory,
    context: ts.TransformationContext,
    visitor: ts.Visitor,
    options: NormalizedPreferConstOptions,
    statistics: TransformStatistics,
): ts.ForOfStatement {
    void context;

    const initializer = ts.isVariableDeclarationList(
        statement.initializer,
    )
        ? transformLoopDeclarationList(
            statement.initializer,
            analysis,
            factory,
            options,
            statistics,
        )
        : ts.visitNode(
            statement.initializer,
            visitor,
            ts.isExpression,
        );

    return factory.updateForOfStatement(
        statement,
        statement.awaitModifier,
        initializer!,
        ts.visitNode(
            statement.expression,
            visitor,
            ts.isExpression,
        ) || statement.expression,
        ts.visitNode(
            statement.statement,
            visitor,
            ts.isStatement,
        ) || statement.statement,
    );
}

function transformLoopDeclarationList(
    declarationList: ts.VariableDeclarationList,
    analysis: SourceFileAnalysis,
    factory: ts.NodeFactory,
    options: NormalizedPreferConstOptions,
    statistics: TransformStatistics,
): ts.VariableDeclarationList {
    if (!isSupportedDeclarationList(declarationList, options)) {
        return declarationList;
    }

    const declarations = declarationList.declarations;
    const declarationAnalyses = declarations.map(
        (declaration) => analysis.declarations.get(declaration),
    );

    /*
     * A declaration list in a loop initializer cannot be split into multiple
     * declaration statements. Convert it only if every declaration qualifies.
     */
    const allConvertible = declarationAnalyses.every(
        (entry) => entry?.canBecomeConst === true,
    );

    if (!allConvertible) {
        statistics.skippedDeclarations += declarations.length;

        logSkippedDeclarations(
            declarationAnalyses,
            declarationList.getSourceFile(),
            options,
        );

        return declarationList;
    }

    statistics.convertedStatements++;
    statistics.convertedDeclarations += declarations.length;

    options.logger(
        `Converted loop declaration at ` +
        `${formatLocation(declarationList)} to const.`,
    );

    const constDeclarationList =
        factory.createVariableDeclarationList(
            declarations,
            ts.NodeFlags.Const,
        );

    ts.setOriginalNode(
        constDeclarationList,
        declarationList,
    );

    ts.setTextRange(
        constDeclarationList,
        declarationList,
    );

    return constDeclarationList;
}

function groupDeclarations(
    declarationList: ts.VariableDeclarationList,
    analysis: SourceFileAnalysis,
): DeclarationGroup[] {
    const originalFlags = getDeclarationKindFlags(
        declarationList.flags,
    );

    const groups: DeclarationGroup[] = [];

    for (const declaration of declarationList.declarations) {
        const declarationAnalysis =
            analysis.declarations.get(declaration);

        const flags = declarationAnalysis?.canBecomeConst
            ? ts.NodeFlags.Const
            : originalFlags;

        const previousGroup = groups[groups.length - 1];

        if (previousGroup?.flags === flags) {
            previousGroup.declarations.push(declaration);
        } else {
            groups.push({
                flags,
                declarations: [declaration],
            });
        }
    }

    return groups;
}

function getBindingIdentifiers(
    bindingName: ts.BindingName,
    checker: ts.TypeChecker,
): BindingIdentifier[] {
    const result: BindingIdentifier[] = [];

    visitBindingName(bindingName);

    return result;

    function visitBindingName(name: ts.BindingName): void {
        if (ts.isIdentifier(name)) {
            const symbol = getCanonicalSymbol(
                checker.getSymbolAtLocation(name),
                checker,
            );

            if (symbol) {
                result.push({
                    identifier: name,
                    symbol,
                });
            }

            return;
        }

        for (const element of name.elements) {
            if (ts.isOmittedExpression(element)) {
                continue;
            }

            visitBindingName(element.name);
        }
    }
}

function getCanonicalSymbol(
    symbol: ts.Symbol | undefined,
    checker: ts.TypeChecker,
): ts.Symbol | undefined {
    if (!symbol) {
        return undefined;
    }

    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        return checker.getAliasedSymbol(symbol);
    }

    return symbol;
}

function isWriteReference(identifier: ts.Identifier): boolean {
    let current: ts.Node = identifier;

    while (current.parent) {
        const parent = current.parent;

        if (
            ts.isParenthesizedExpression(parent) ||
            ts.isAsExpression(parent) ||
            ts.isTypeAssertionExpression(parent) ||
            ts.isNonNullExpression(parent) ||
            ts.isSatisfiesExpression(parent)
        ) {
            current = parent;
            continue;
        }

        /*
         * Property mutation does not reassign the underlying variable:
         *
         *     value.property = 1;
         *     value[index] = 1;
         */
        if (ts.isPropertyAccessExpression(parent)) {
            return false;
        }

        if (ts.isElementAccessExpression(parent)) {
            return false;
        }

        if (
            ts.isPrefixUnaryExpression(parent) ||
            ts.isPostfixUnaryExpression(parent)
        ) {
            return (
                parent.operator === ts.SyntaxKind.PlusPlusToken ||
                parent.operator === ts.SyntaxKind.MinusMinusToken
            );
        }

        if (
            ts.isBinaryExpression(parent) &&
            isAssignmentOperator(parent.operatorToken.kind)
        ) {
            return (
                parent.left === current ||
                isNodeWithin(current, parent.left)
            );
        }

        /*
         * Continue walking through destructuring-assignment targets:
         *
         *     [value] = source;
         *     ({ value } = source);
         *     ({ property: value } = source);
         */
        if (
            ts.isArrayLiteralExpression(parent) ||
            ts.isObjectLiteralExpression(parent) ||
            ts.isSpreadElement(parent) ||
            ts.isSpreadAssignment(parent)
        ) {
            current = parent;
            continue;
        }

        if (ts.isPropertyAssignment(parent)) {
            if (parent.initializer === current) {
                current = parent;
                continue;
            }

            return false;
        }

        if (ts.isShorthandPropertyAssignment(parent)) {
            current = parent;
            continue;
        }

        /*
         * The identifier that appears in its own declaration is not a
         * reassignment.
         */
        if (
            ts.isVariableDeclaration(parent) &&
            isNodeWithin(identifier, parent.name)
        ) {
            return false;
        }

        /*
         * Parameters, functions, classes, imports, catch bindings, and other
         * declaration names are not write references to the candidate
         * variable.
         */
        if (isDeclarationName(identifier)) {
            return false;
        }

        return false;
    }

    return false;
}

function isDeclarationName(identifier: ts.Identifier): boolean {
    const parent = identifier.parent;

    if (
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isModuleDeclaration(parent) ||
        ts.isImportClause(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isImportEqualsDeclaration(parent) ||
        ts.isTypeParameterDeclaration(parent) ||
        ts.isBindingElement(parent)
        //|| ts.isCatchClause(parent)
    ) {
        return parent.name === identifier;
    }

    return false;
}

function isAssignmentOperator(
    kind: ts.SyntaxKind,
): boolean {
    switch (kind) {
        case ts.SyntaxKind.EqualsToken:
        case ts.SyntaxKind.PlusEqualsToken:
        case ts.SyntaxKind.MinusEqualsToken:
        case ts.SyntaxKind.AsteriskEqualsToken:
        case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
        case ts.SyntaxKind.SlashEqualsToken:
        case ts.SyntaxKind.PercentEqualsToken:
        case ts.SyntaxKind.LessThanLessThanEqualsToken:
        case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
        case ts.SyntaxKind.AmpersandEqualsToken:
        case ts.SyntaxKind.BarEqualsToken:
        case ts.SyntaxKind.CaretEqualsToken:
        case ts.SyntaxKind.BarBarEqualsToken:
        case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
        case ts.SyntaxKind.QuestionQuestionEqualsToken:
            return true;

        default:
            return false;
    }
}

function isNodeWithin(
    node: ts.Node,
    potentialAncestor: ts.Node,
): boolean {
    let current: ts.Node | undefined = node;

    while (current) {
        if (current === potentialAncestor) {
            return true;
        }

        current = current.parent;
    }

    return false;
}

function isSupportedDeclarationList(
    declarationList: ts.VariableDeclarationList,
    options: NormalizedPreferConstOptions,
): boolean {
    if (isConstDeclarationList(declarationList)) {
        return false;
    }

    if (
        isVarDeclarationList(declarationList) &&
        !options.includeVarDeclarations
    ) {
        return false;
    }

    return true;
}

function isConstDeclarationList(
    declarationList: ts.VariableDeclarationList,
): boolean {
    return (
        declarationList.flags & ts.NodeFlags.Const
    ) !== 0;
}

function isLetDeclarationList(
    declarationList: ts.VariableDeclarationList,
): boolean {
    return (
        declarationList.flags & ts.NodeFlags.Let
    ) !== 0;
}

function isVarDeclarationList(
    declarationList: ts.VariableDeclarationList,
): boolean {
    return (
        declarationList.flags &
        (ts.NodeFlags.Let | ts.NodeFlags.Const)
    ) === 0;
}

function getDeclarationKindFlags(
    flags: ts.NodeFlags,
): ts.NodeFlags {
    if ((flags & ts.NodeFlags.Const) !== 0) {
        return ts.NodeFlags.Const;
    }

    if ((flags & ts.NodeFlags.Let) !== 0) {
        return ts.NodeFlags.Let;
    }

    return ts.NodeFlags.None;
}

function shouldTransformSourceFile(
    sourceFile: ts.SourceFile,
    options: NormalizedPreferConstOptions,
): boolean {
    if (
        sourceFile.isDeclarationFile &&
        !options.includeDeclarationFiles
    ) {
        return false;
    }

    if (
        !options.includeJavaScriptFiles &&
        isJavaScriptSourceFile(sourceFile)
    ) {
        return false;
    }

    return true;
}

function isJavaScriptSourceFile(
    sourceFile: ts.SourceFile,
): boolean {
    return (
        sourceFile.scriptKind === ts.ScriptKind.JS ||
        sourceFile.scriptKind === ts.ScriptKind.JSX
    );
}

function logSkippedDeclarations(
    analyses: readonly (
        | DeclarationAnalysis
        | undefined
    )[],
    sourceFile: ts.SourceFile,
    options: NormalizedPreferConstOptions,
): void {
    for (const analysis of analyses) {
        if (!analysis || analysis.canBecomeConst) {
            continue;
        }

        options.logger(
            `Skipped declaration at ` +
            `${formatLocation(analysis.declaration, sourceFile)}: ` +
            `${analysis.reason ?? "Declaration is not eligible."}`,
        );
    }
}

function formatLocation(
    node: ts.Node,
    explicitSourceFile?: ts.SourceFile,
): string {
    const sourceFile =
        explicitSourceFile ?? node.getSourceFile();

    const position =
        sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
        );

    return (
        `${sourceFile.fileName}:` +
        `${position.line + 1}:` +
        `${position.character + 1}`
    );
}

function copySyntheticComments(
    source: ts.Node,
    target: ts.Node,
): void {
    const leading =
        ts.getSyntheticLeadingComments(source);

    const trailing =
        ts.getSyntheticTrailingComments(source);

    if (leading) {
        ts.setSyntheticLeadingComments(
            target,
            [...leading],
        );
    }

    if (trailing) {
        ts.setSyntheticTrailingComments(
            target,
            [...trailing],
        );
    }
}

interface NormalizedPreferConstOptions {
    includeVarDeclarations: boolean;
    splitMixedDeclarations: boolean;
    includeJavaScriptFiles: boolean;
    includeDeclarationFiles: boolean;
    logger: (message: string) => void;
}

function normalizeOptions(
    options: PreferConstOptions,
): NormalizedPreferConstOptions {
    return {
        ...defaultOptions,
        ...options,
        logger: options.logger ?? (() => undefined),
    };
}

const preferConstTransformerPlugin: ({
    program,
}: {
    program?: ts.Program;
}) => ts.TransformerFactory<ts.SourceFile> = ({
    program,
}) => {
        if (!program) {
            throw new Error(
                "prefer-const-transformer requires a TypeScript Program. " +
                "Pass { program } when creating the transformer.",
            );
        }

        return createPreferConstTransformer(program, {
            logger: console.log,
            includeVarDeclarations: true,
            splitMixedDeclarations: false,
            includeJavaScriptFiles: true,
            includeDeclarationFiles: true
        });
    };

export default preferConstTransformerPlugin;