import ts from "typescript";

let opts: ts.CompilerOptions = {
    "allowJs": true,
    "checkJs": false,
    "declaration": true,
    "downlevelIteration": false,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "experimentalDecorators": true,
    "importHelpers": true,
    "isolatedModules": false,
    "module": ts.ModuleKind.CommonJS,
    "moduleResolution": ts.ModuleResolutionKind.Node16,
    "lib": [
        "ES2022",
        "DOM"
    ],
    "target": ts.ScriptTarget.Latest,
    //"strictNullChecks": false
};
export interface BindingTools {
    program: ts.Program;
    ls: ts.LanguageService;
    compilerHost: ts.CompilerHost & ts.LanguageServiceHost;
    context: ts.TransformationContext;
}
export function getSourceText(sourceFile?: ts.SourceFile) {
    return !!sourceFile ? ts.createPrinter().printFile(sourceFile) : "";
}
export function getBindingTools(sourceFiles: ts.SourceFile[], options: ts.CompilerOptions = ts.getDefaultCompilerOptions(), setParentNodes: boolean = false, context: ts.TransformationContext): BindingTools {
    let files: { [x: string]: { file?: ts.SourceFile | undefined; version?: number; }; } = {};
    if (!options.target)
        options.target = ts.ScriptTarget.Latest;
    //options.target = languageVersionOrOptions;
    sourceFiles.forEach(sf => files[sf.fileName] = {
        file: sf,
        version: 0
    });
    const compilerHost: ts.CompilerHost & ts.LanguageServiceHost = {
        getScriptVersion: fileName => files[fileName]?.version + "",
        getScriptSnapshot: fileName => ts.ScriptSnapshot.fromString(getSourceText(files[fileName]?.file)),
        getCompilationSettings: () => options,
        getScriptFileNames: () => Object.keys(files),
        getSourceFile: (fileName, _languageVersion?) => files[fileName]?.file,
        writeFile: (fileName: string, text: string) => {
            let sourceFile = ts.createSourceFile(fileName, text, options.target!, setParentNodes);
            /*if (files[fileName])
              files[fileName] = {
                file: sourceFile,
                version: files[fileName].version++
              };
            else*/
            files[fileName].file = sourceFile;
            /*if (files[fileName])
              files[fileName] = {
                file: sourceFile,
                version: files[fileName].version++
              };
            else*/
            files[fileName].version = 0;
        },
        getDefaultLibFileName: (defaultLibOptions: ts.CompilerOptions) => ts.getDefaultLibFileName(defaultLibOptions),
        getCurrentDirectory: () => "./",
        fileExists: (fileName: string) => !!files[fileName],
        readFile: (fileName: string) => getSourceText(files[fileName]?.file),
        getCanonicalFileName: (fileName: string) => fileName,
        useCaseSensitiveFileNames: () => false,
        getNewLine: () => "\n",
    };
    //console.log(`target: ${ts.ScriptTarget[options.target]}`);
    const ls = ts.createLanguageService(compilerHost, ts.createDocumentRegistry(false, "./"), ts.LanguageServiceMode.Semantic);
    const program = ts.createProgram(Object.keys(files), options, compilerHost);
    return { program, ls, compilerHost, context };
}
function fixFiles(binding: BindingTools, ...filter: number[]) {
    try {
        binding = getBindingTools(
            binding.program.getSourceFiles()
                .map(sf => transformer(sf, binding.program, binding.context)),
            binding.program.getCompilerOptions(),
            false,
            binding.context
        );
        for (var i = 0; i < 25; i++) {
            try {
                var changes = 0;
                var files = [];
                for (var sourceFile of binding.program.getSourceFiles()) {
                    console.log(`applyFixes ${sourceFile.fileName} ${filter}: ${i}`);
                    var newText = getSourceText(sourceFile);
                    try {
                        newText = applyFixes(sourceFile, binding.ls, [...binding.ls.getSuggestionDiagnostics(sourceFile.fileName), ...binding.ls.getSemanticDiagnostics(sourceFile.fileName)], undefined, undefined, ...filter);
                        changes++;
                    }
                    catch (ex) {
                        //console.warn(ex)
                        //console.log(`applyFixes ${sourceFile.fileName} done`);
                        // files.push(sourceFile);
                    }
                    files.push(ts.createSourceFile(sourceFile.fileName, newText, sourceFile.languageVersion, !!sourceFile.parent));
                }
                if (changes == 0)
                    break;
                else {
                    binding = getBindingTools(files, binding.program.getCompilerOptions(), false, binding.context);
                }
            }
            catch (ex) {
                break;
            }
        }
    }
    catch (ex) {
    }
    return binding;
}
export function fixCode(binding1: BindingTools, ...filter1: number[]) {
    function fixFile(sourceFile: ts.SourceFile) {
        try {
            var binding: BindingTools;
            for (var i = 0; i < 25; i++) {
                binding = getBindingTools([sourceFile], compilerOpts, false, binding1.context);
                sourceFile = transformer(binding.program.getSourceFiles()[0], binding.program, binding.context);
                console.log(`applyFixes ${sourceFile.fileName} ${filter1}: ${i}`);
                binding = getBindingTools([sourceFile], compilerOpts, false, binding1.context);

                try {
                    var newText = applyFixes(sourceFile, binding.ls, [...binding.ls.getSuggestionDiagnostics(sourceFile.fileName), ...binding.ls.getSemanticDiagnostics(sourceFile.fileName)], undefined, undefined, ...filter1);
                    sourceFile = ts.createSourceFile(sourceFile.fileName, newText, sourceFile.languageVersion, !!sourceFile.parent);
                }
                catch (ex) {
                    //console.log(`applyFixes ${sourceFile.fileName} done`);
                    return sourceFile;
                }
            }
            return binding!.program.getSourceFiles()[0];
        }
        catch (ex) {
            return sourceFile;
        }
    }
    var compilerOpts = binding1.program.getCompilerOptions();
    let sourceFiles = binding1.program.getSourceFiles().map(fixFile);
    return getBindingTools(sourceFiles, binding1.program.getCompilerOptions(), false, binding1.context);
}
export function applyFixes(sourceFile: ts.SourceFile, ls: ts.LanguageService, _diagnostics: ts.Diagnostic[] = [], formatContext: ts.FormatCodeSettings = {}, preferences: ts.UserPreferences = {}, ...filter: number[]) {
    function doLoop(diag: ts.Diagnostic) {
        if ((diag.start && posWithFixes.has(diag.start)) || newInt.size > 0) {
            console.warn(`Skipping ${diag} because a fix is already being applied at this location.`);
        }

        let fixActions = ls.getCodeFixesAtPosition(diag.file!.fileName, diag.start!, diag.start! + diag.length!, [diag.code], formatContext, preferences)
            .filter(fix => fix.fixName != "disableJsDiagnostics" && fix.fixName != "spelling");
        console.log({ ...diag, fixActions });

        if (fixActions.length > 0) {
            if (fixActions.length > 1 && diag.code == 2339 && fixActions.some(fix => fix.fixId == "fixMissingMember" && fix.description.startsWith("Declare property")))
                fixActions = fixActions.filter(fix => fix.description.startsWith("Declare property"));
            const action = fixActions[0];
            var diagKey = diag.messageText;
            if (!diagMap.has(diagKey))
                diagMap.set(diagKey, []);
            diagMap.set(diagKey, diagMap.get(diagKey).concat([action]));
            for (const c of action.changes) {
                if (c.textChanges && c.textChanges.length) {
                    var ch2 = c.textChanges
                        /*.map(changes => {
                            changes.newText = changes.newText
                                .replaceAll(": any[]", "       ")
                                .replaceAll(": any", "     ")
                                .replaceAll(": {}", "   ")
                            return changes; 
                        })*/
                        //.filter(change => change.newText.trim().length > 0)
                        .filter((a, i, arr) => arr.findIndex((val) => val.newText == a.newText && val.span.start == a.span.start && val.span.length == a.span.length) == i)
                        .map(t => Object.assign({ diag, fixActions }, t));
                    if (ch2.length > 0) {
                        fileChanges = fileChanges.concat(ch2);
                        if (diag.start) {
                            posWithFixes.add(diag.start);
                        }
                    }
                }
            }
        }
    }

    var newInt = new Set<string>();
    let fileChanges: ts.TextChange[] = [];
    const posWithFixes = new Set<number>();
    let diagnostics = ts.sortAndDeduplicateDiagnostics(_diagnostics
        .filter(d => d.code != 6133)
        .filter(d => filter.includes(2304) ? !!d : d.code != 2304)
        .filter(d => filter.length == 0 || filter.includes(d.code))
        .filter(d => d.file?.fileName == sourceFile.fileName))
        .filter(d => d.code == 80002 ? sourceFile.languageVersion > ts.ScriptTarget.ES5 : true);
    const diagMap = new Map();

    try {
        diagnostics.forEach(doLoop);
    } catch (ex) {
        console.warn(`Error applying fixes: ${ex}`);
    }

    // Apply fixes in descending order so we don't mess up positions for the next fixes.
    fileChanges = fileChanges
        .sort((a, b) => b.span.start - a.span.start);
    if (fileChanges.length == 0)
        throw new Error("No changes");
    console.log(`fixing ${sourceFile.fileName}: ${fileChanges.length}`);
    console.log(fileChanges);
    let content = getSourceText(sourceFile);
    let lastChangeStartPos = content.length;
    for (const change of fileChanges) {
        try {
            let oldContent = content;
            let { start, length } = change.span;
            if (start + length > lastChangeStartPos) {
                //console.warn(`skipping ${change.newText}`);
                continue;
            }
            if (start == lastChangeStartPos) {
                //console.warn(`skipping ${change.newText}`);
                continue;
            }
            content = oldContent.substring(0, start) + change.newText + oldContent.substring(start + length);
            //sourceFile = sourceFile.update(content, ts.createTextChangeRange(change.span, content.length));
            //content = oldContent.substring(0, start) + change.newText;
            //if (length >= oldContent.length)
            //content += oldContent.substring(start + length);
            lastChangeStartPos = start;
        } catch (ex) {
            continue;
        }
    }
    return content;
}

function getText(node: ts.Node): string | null {
    if (!node)
        return null;
    if (ts.isIdentifier(node))
        return node.text;
    try {
        return node.getText();
    }
    catch (ex) {
    }
    if (node.hasOwnProperty("text"))
        return (node as any).text;
    if (node.hasOwnProperty("name"))
        return getText((node as any)["name"]);
    return null;
}

function isLiteral(node: ts.Node): node is ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | ts.NumericLiteral | ts.StringLiteralLike {
    return (ts.isObjectLiteralExpression(node) ||
        ts.isArrayLiteralExpression(node) ||
        ts.isNumericLiteral(node) ||
        ts.isStringLiteralLike(node))
}
/**
 * The Node transformer signature is the simplest: it takes a node as argument and returns a node.
 * If you need a more complex transformer you can choose one from the different templates provided by the plugin
 */
export const transformer = (sourceFile: ts.SourceFile, program: ts.Program, context: ts.TransformationContext, isJS?: boolean) => {
    const factory = context.factory;
    const checker = program.getTypeChecker();
    const validProperty = /^(?![0-9])[a-zA-Z0-9$_]+$/;
    function isAssignableTo(node: ts.Node, type: ts.Type, checkAny?: boolean) {
        var nodeType = checker.getTypeAtLocation(node);
        var flags = nodeType.getFlags();
        //console.log(`${getText(node)}: ${ts["Debug"].formatTypeFlags(flags)}`);
        if (((flags & ts.TypeFlags.Unknown) > 0 || (flags & ts.TypeFlags.Any) > 0))
            return false;
        //console.log(`${getText(node)}: ${(nodeType as any)['intrinsicName']}`);
        //console.log(nodeType);
        return checker.isTypeAssignableTo(nodeType, type);
    }
    function getInitializer(node: ts.Node) {
        if (ts.hasOnlyExpressionInitializer(node))
            return node.initializer!;
        if (ts.isBinaryExpression(node) && node.operatorToken.kind == ts.SyntaxKind.EqualsToken)
            return node.right;
        return undefined;
    }
    function isInitializer(node?: ts.Node): node is ts.HasExpressionInitializer | ts.BinaryExpression {
        return !!node && (ts.hasOnlyExpressionInitializer(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind == ts.SyntaxKind.EqualsToken));
    }
    function getTypeNode(node: ts.Node | undefined, ignoreSymbol?: boolean) {
        if (!node)
            return undefined;
        var nodeType = checker.getTypeAtLocation(node);
        var flags = nodeType.getFlags();
        if (
            //(flags & ts.TypeFlags.Unknown) > 0 || 
            (flags & ts.TypeFlags.Any) > 0) {
            if (isInitializer(node))
                return getTypeNode(getInitializer(node), true);
            /*if (!ignoreSymbol && !!nodeType.getSymbol())
                return nodeType.getSymbol()!.declarations!.find(decl => getTypeNode(decl, true));*/
            return undefined;
        }

        return checker.typeToTypeNode(nodeType, undefined, undefined);
    }

    const visitor: ts.Visitor = (node) => {
        if (!node)
            return undefined;

        //node = ts.visitEachChild(node, visitor, context);

        if (ts.isAssertionExpression(node) && ts.isConstTypeReference(node.type) || ts.isJSDocTypeTag(node) && ts.isConstTypeReference(node.typeExpression))
            return node;
        if (ts.isTypeNode(node) && (node.flags & ts.TypeFlags.Any || node.flags & ts.TypeFlags.Unknown || (ts.isArrayTypeNode(node) && (node.elementType.flags & ts.TypeFlags.Any || node.elementType.flags & ts.TypeFlags.Unknown || node.elementType.flags & ts.TypeFlags.Never))))
            return undefined;
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text == "extendsObject" && ts.isIdentifier(node.expression.expression) && node.expression.expression.text == "Object" && node.arguments.length == 2) {
            return ts.visitNode(node.arguments[1], visitor);
        }
        if (ts.isParenthesizedExpression(node) && ts.isLiteralExpression(node.expression)) {
            return ts.visitNode(node.expression, visitor);
        }

        if (ts.isTemplateSpan(node)) {
            if (ts.isStringLiteralLike(node.expression))
                return ts.visitNode(factory.createStringLiteral(node.expression.text + node.literal.text), visitor);
            /*if (ts.isTemplateExpression(node.expression) && node.literal.text == "")
                return ts.visitNodes(factory.createTemplateSpan(
                    node.expression.
                ), visitor)*/
        }
        /*if (ts.isTemplateExpression(node) && node.parent && ts.isTemplateSpan(node.parent)) {
            console.log("yo");
            return ts.visitNode(factory.createTemplateExpression(
                node.head,
                node.templateSpans.reduce((state, curr) => {
                    if (ts.isTemplateExpression(curr.expression))
                        return state.concat([factory.createTemplateSpan(
                                factory.createStringLiteral(curr.expression.head.text),
                                factory.createTemplateMiddle("")
                            ), ...curr.expression.templateSpans]);
                    return state.concat([curr]);
                }, [] as ts.TemplateSpan[])
            ), visitor);
        }*/

        if (ts.isBinaryExpression(node)) {
            var left: ts.Expression = node.left;
            var right: ts.Expression = node.right;

            if (ts.isNumericLiteral(left) && ts.isNumericLiteral(right)) {
                const lhs = Number(left.text);
                const rhs = Number(right.text);
                switch (node.operatorToken.kind) {
                    case ts.SyntaxKind.PlusToken:
                        return ts.visitNode(factory.createNumericLiteral(lhs + rhs), visitor);
                    case ts.SyntaxKind.MinusToken:
                        return ts.visitNode(factory.createNumericLiteral(lhs - rhs), visitor);
                    case ts.SyntaxKind.AsteriskToken:
                        return ts.visitNode(factory.createNumericLiteral(lhs * rhs), visitor);
                    case ts.SyntaxKind.SlashToken:
                        return ts.visitNode(factory.createNumericLiteral(lhs / rhs), visitor);
                }
            }
            if (node.operatorToken.kind == ts.SyntaxKind.PlusToken && isAssignableTo(node, checker.getStringType())) {
                console.log(getText(left) + " /+/ " + getText(right));
                //if (ts.isBinaryExpression(left))
                //left = ts.visitNode(left, visitor) as ts.Expression;
                //if (ts.isBinaryExpression(right))
                // right = ts.visitNode(right, visitor) as ts.Expression;

                if (ts.isStringLiteralLike(left) && ts.isStringLiteralLike(right)) {
                    console.log("strings");
                    return ts.visitNode(factory.createStringLiteral(left.text + right.text), visitor);
                    /*return ts.visitNode(factory.createTemplateExpression(
                        factory.createTemplateHead(left.text),
                        [
                            factory.createTemplateSpan(
                                factory.createStringLiteral(right.text),
                                factory.createTemplateTail("")
                            )
                        ]
                    ), visitor)*/
                }

                /*if (false && ts.isTemplateExpression(left)) {
                    return ts.visitNode(factory.createTemplateExpression(
                        left.head,
                        [
                            ...left.templateSpans.map(span => factory.createTemplateSpan(
                                span.expression,
                                factory.createTemplateMiddle(span.literal.text)
                            )),
                            factory.createTemplateSpan(
                                right,
                                factory.createTemplateTail("")
                            )
                        ]
                    ), visitor);
                }

                if (false && ts.isTemplateExpression(right)) {
                    return ts.visitNode(factory.createTemplateExpression(
                        factory.createTemplateHead(""),
                        [
                           factory.createTemplateSpan(
                                left,
                                factory.createTemplateMiddle("")
                            ),     
                            ...right.templateSpans.map(span => factory.createTemplateSpan(
                                span.expression,
                                factory.createTemplateMiddle(span.literal.text)
                            )),
                            factory.createTemplateSpan(
                                factory.createStringLiteral(""),
                                factory.createTemplateTail("")
                            ),
                        ]
                    ), visitor);
                }*/

                if (ts.isStringLiteralLike(left)) {
                    if (left.text == "" && isAssignableTo(right, checker.getStringType()))
                        return right;
                    return ts.visitNode(factory.createTemplateExpression(
                        factory.createTemplateHead(left.text),
                        [
                            factory.createTemplateSpan(
                                right,
                                factory.createTemplateTail("")
                            )
                        ]
                    ), visitor)
                }

                if (ts.isStringLiteralLike(right)) {
                    if (right.text == "" && isAssignableTo(left, checker.getStringType()))
                        return left;
                    return ts.visitNode(factory.createTemplateExpression(
                        factory.createTemplateHead(""),
                        [
                            factory.createTemplateSpan(
                                left,
                                factory.createTemplateTail(right.text)
                            )
                        ]
                    ), visitor)
                }

                //if (isAssignableTo(node, checker.getStringType()))

                return ts.visitNode(factory.createTemplateExpression(
                    factory.createTemplateHead(""),
                    [
                        factory.createTemplateSpan(
                            left,
                            factory.createTemplateMiddle("")
                        ),
                        factory.createTemplateSpan(
                            right,
                            factory.createTemplateTail("")
                        )
                    ]
                ), visitor)
            }
            if (node.operatorToken.kind == ts.SyntaxKind.EqualsToken) {
                if (ts.isPropertyAccessExpression(left)) {
                    if (ts.isPropertyAccessExpression(left.expression) && left.expression.name.text == "prototype") {
                        //console.log(left.expression.expression.getText());
                        //console.log(checker.getTypeAtLocation(left.expression.name))
                    }
                }
            }
        }
        if (isLiteral(node)) {
            var flag = false;
            if (!!node.parent && ts.isReturnStatement(node.parent)) {
                if (ts.isReturnStatement(node.parent))
                    flag = true;
            }
            else if (!!node.parent && ts.isPropertyAssignment(node.parent) && ts.isObjectLiteralExpression(node.parent.initializer)) {
                flag = false;
            }
            else {
                try {
                    var parentName = getText((node.parent as any)["name"]);
                    if (!!parentName && parentName != "" && (parentName == parentName.toUpperCase() || parentName == "type"))
                        flag = true;
                    if (parentName == "prototype")
                        flag = true;
                }
                catch (ex) {
                    flag = false;
                }
            }

            if (ts.isObjectLiteralExpression(node) && node.properties.length == 0)
                flag = false;
            if (ts.isArrayLiteralExpression(node) && node.elements.length > 0)
                flag = true;
            if (ts.isStringLiteralLike(node) && node.text == "")
                flag = false;
          	/*if (node.parent && ts.isAsExpression(node.parent) && ts.isConstTypeReference(node.parent.type))
				flag = false;*/
            //console.log(`const: ${flag} ${printEnum(ts.SyntaxKind, node.kind)}`);
            //console.log(node);              
            if (flag) {
                //return ts.addSyntheticLeadingComment(factory.createParenthesizedExpression(node), ts.SyntaxKind.MultiLineCommentTrivia, `* @type {const} `, false)
                return factory.createAsExpression(
					ts.visitEachChild(node, visitor, context), 
					factory.createTypeReferenceNode(
						factory.createIdentifier("const")
						)
				)
            }
        }
        if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && validProperty.test(node.argumentExpression.text)) {
            return ts.visitNode(factory.createPropertyAccessExpression(node.expression, node.argumentExpression.text), visitor);
        }

        // Convert variable statement lists
        if (ts.isVariableStatement(node)) {
            var stmts = node.declarationList.declarations
                .reduce((state: ts.VariableStatement[], decl) => state.concat(factory.createVariableStatement(node.modifiers, factory.createVariableDeclarationList([factory.createVariableDeclaration(decl.name, decl.exclamationToken, decl.type, decl.initializer)], node.declarationList.flags))), []);
            if (node.declarationList.declarations.length > 1) {
                return ts.visitNodes(factory.createNodeArray(stmts), visitor).filter((a) => !!a);
            }
            // Convert function statements to declarations
            if (node.declarationList.declarations.length == 1) {
                var stmt = node.declarationList.declarations[0];
                var nodeType = undefined;// checker.typeToTypeNode(checker.getTypeAtLocation(stmt), undefined, ts.NodeBuilderFlags.IgnoreErrors);
                //if (nodeType && checker.isTypeAssignableTo(checker.getAnyType(), checker.getTypeFromTypeNode(nodeType)))
                //     nodeType = undefined;

                if (!!stmt.initializer) {
                    if (ts.isIdentifier(stmt.name) && ts.isPropertyAccessExpression(stmt.initializer) && stmt.initializer.name.text == "create" && stmt.initializer.expression && ts.isIdentifier(stmt.initializer.expression) && stmt.initializer.expression.text == "Class") {
                        return ts.visitNode(factory.createClassDeclaration(
                            undefined,
                            stmt.name,
                            undefined,
                            undefined,
                            []
                        ), visitor)
                    }

                    if (ts.isFunctionExpression(stmt.initializer) && ts.isIdentifier(stmt.name)) {
                        return ts.visitNode(
                            factory.createFunctionDeclaration(
                                stmt.initializer.modifiers,
                                stmt.initializer.asteriskToken,
                                stmt.name,
                                stmt.initializer.typeParameters,
                                stmt.initializer.parameters,
                                stmt.initializer.type,
                                stmt.initializer.body),
                            visitor
                        );
                    }
                    /*if (ts.isStringLiteralLike(stmt.initializer) && stmt.initializer.text == "") {
                        return ts.visitNodes(factory.createNodeArray([
                            factory.createVariableStatement(node.modifiers, factory.createVariableDeclarationList([
                                factory.createVariableDeclaration(stmt.name, stmt.exclamationToken, stmt.type, undefined)
                            ], node.declarationList.flags))
                        ]), visitor).filter((a) => !!a);
                    }*/
                    /*if (ts.isObjectLiteralExpression(stmt.initializer) && stmt.initializer.properties.length == 0) {
                        return ts.visitNodes(factory.createNodeArray([
                            factory.createVariableStatement(node.modifiers, factory.createVariableDeclarationList([
                                factory.createVariableDeclaration(stmt.name, stmt.exclamationToken, stmt.type, stmt.initializer)
                            ], node.declarationList.flags | ts.NodeFlags.Const)),
                            //factory.createAssignment(factory.createIdentifier(getText(stmt.name)!), stmt.initializer)
                        ]), visitor).filter((a) => !!a);
                    }*/
                    /*if (ts.isArrayLiteralExpression(stmt.initializer) && stmt.initializer.elements.length == 0) {
                        return ts.visitNodes(factory.createNodeArray([
                            factory.createVariableStatement(node.modifiers, factory.createVariableDeclarationList([
                                factory.createVariableDeclaration(stmt.name, stmt.exclamationToken, stmt.type, stmt.initializer)
                            ], node.declarationList.flags | ts.NodeFlags.Const)),
                            //factory.createAssignment(factory.createIdentifier(getText(stmt.name)!), stmt.initializer)
                        ]), visitor).filter((a) => !!a);
                    }*/
                }
            }
        }
        ;
        // Property assignment
        if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind == ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.expression.left) && node.expression.left.name.text == "prototype") {
            let exprLeft = node.expression.left;
            let exprRight = ts.visitNode(node.expression.right, visitor);
            if (ts.isObjectLiteralExpression(exprRight!)) {
                if (exprRight.properties.length == 0) {
                }
                else {
                    console.log(`fixing props ${getText(exprLeft)}`);
                    if (!getText(exprLeft))
                        console.log(exprLeft);
                    let props = exprRight.properties
                        .map(propNode => {
                            if (ts.isPropertyAssignment(propNode)) {
                                var ret: (ts.ExpressionStatement | ts.JSDoc)[] = [];
                                var jsDoc = (propNode as any).jsDoc;
                                if (!!jsDoc) {
                                    //console.log(jsDoc);
                                    if (ts.isJSDoc(jsDoc))
                                        ret.push(jsDoc);
                                    else
                                        ret = ret.concat(jsDoc);
                                }
                                else {
                                    /*let text = getSourceText(sourceFile);
                                    let comments = (ts.getLeadingCommentRanges(text, propNode.pos) || []).map((r) => {
                                      const commentContent =
                                        r.kind === ts.SyntaxKind.MultiLineCommentTrivia ? text.slice(r.pos + 2, r.end - 2) : text.slice(r.pos + 2, r.end);
                                      //ret.push(context.factory.createJSDocComment(commentContent));
                                      return commentContent;
                                    });
                                    if (comments.length > 0)
                                      ret.push(factory.createJSDocComment(comments.join("\n").trim()));*/
                                }
                                if ((ts.isStringLiteralLike(propNode.name) || ts.isMemberName(propNode.name)) && propNode.name.text.match(validProperty)) {
                                    let assn = factory.createAssignment(factory.createPropertyAccessExpression(exprLeft, propNode.name.text), propNode.initializer);
                                    ret.push(factory.createExpressionStatement(assn));
                                }
                                return ret.filter((a) => !!a);
                            }
                            return [];
                        })
                        .reduce((a, b) => a.concat(b), [])
                        .filter((expr) => !!expr);
                    return ts.visitNodes(factory.createNodeArray(props), visitor).filter((a) => !!a);
                }
            }
            if (((ts.isStringLiteralLike(exprRight!) && exprRight.text != "") || (ts.isArrayLiteralExpression(exprRight!) && exprRight.elements.length > 0))) {
                /*return ts.visitNode(factory.createAssignment(exprLeft, factory.createAsExpression(
                    exprRight,
                    factory.createTypeReferenceNode(
                        factory.createIdentifier("const"),
                        undefined
                    )
                )), visitor);*/
            }
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text == "create" && node.expression.expression && ts.isIdentifier(node.expression.expression) && node.expression.expression.text == "Class") {
            return ts.visitNode(
                factory.createFunctionExpression(
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    [
                      /*factory.createParameterDeclaration(
                        undefined,
                        factory.createToken(ts.SyntaxKind.DotDotDotToken),
                        factory.createIdentifier("args"),
                        undefined,
                        undefined,
                        undefined
                    )*/
                    ],
                    undefined,
                    factory.createBlock(
                        [
                          /*factory.createExpressionStatement(factory.createCallExpression(
                            factory.createPropertyAccessExpression(
                                factory.createPropertyAccessExpression(
                                    factory.createThis(),
                                    factory.createIdentifier("initialize")
                                ),
                                factory.createIdentifier("apply")
                            ),
                            undefined,
                            [
                                factory.createThis(),
                                factory.createIdentifier("args")
                            ]
                        ))*/
                        ],
                        true
                    )
                ), visitor);
        }
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isLiteralExpression(node.initializer) && !ts.isNumericLiteral(node.initializer) && node.initializer.text != "" && node.initializer.text != "{}" && node.initializer.text != "[]") {
            //console.log(`${node.left.name?.text}: ${node.right?.text}`)
            return ts.visitNode(factory.createVariableDeclaration(node.name, node.exclamationToken, node.type, factory.createAsExpression(node.initializer, factory.createTypeReferenceNode("const"))), visitor);
        }
        /*if (ts.isVariableStatement(node) && node.declarationList.declarations.length > 1) {
          let stmts = node.declarationList.declarations.map(decl => [factory.createVariableStatement(
            node.modifiers,
            factory.createVariableDeclarationList([factory.createVariableDeclaration(decl.name, decl.exclamationToken, decl.type, decl.initializer)], node.declarationList.flags)
          )]).reduce((state, curr) => state.concat(curr), []);
          return ts.visitNodes(factory.createNodeArray(stmts), visitor).filter((a) => !!a);
        }*/
        /*if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.arguments.length > 0 && ts.isStringLiteral(node.expression.arguments[0]) && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text == "gs.include") {
            factory.createImportDeclaration(
                //undefined,
                undefined, undefined, factory.createStringLiteral(node.expression.arguments[0].text));
        }*/
        /*if (ts.isExpressionStatement(node) && ts.isParenthesizedExpression(node.expression) && ts.isCallExpression(node.expression.expression) && node.expression.expression.arguments.length == 0 && ts.isFunctionExpression(node.expression.expression.expression)) {
          return ts.visitNodes(node.expression.expression.expression.body.statements, visitor).filter((a) => !!a);
        }*/
        if (ts.isClassDeclaration(node)) {
            var members: ts.ClassElement[] = node.members.map(a => a);
            var oldCount = members.length;
            try {
                var classSymbol = checker.getTypeAtLocation(node).getSymbol();
                if (!!classSymbol) {
                    //console.log(classSymbol);
                    members = [...members, ...Array.from(classSymbol.members!.entries())
                        .filter(a => !a[1].valueDeclaration || !ts.isClassElement(a[1].valueDeclaration))
                        .map(sym => {
                            var memberNode = sym[1];
                            if (!!memberNode.valueDeclaration) {
                                var valueDecl = memberNode.valueDeclaration!;
                                if (ts.isClassElement(valueDecl))
                                    return valueDecl;
                                if (ts.isBinaryExpression(valueDecl.parent) && valueDecl.parent.operatorToken.kind == ts.SyntaxKind.EqualsToken) {
                                    return factory.createPropertyDeclaration(undefined, sym[0].toString(), undefined, undefined, valueDecl.parent.right)
                                }
                                return factory.createPropertyDeclaration(undefined, sym[0].toString(), undefined, getTypeNode(valueDecl), undefined)
                            }
                            return undefined;//factory.createPropertyDeclaration(undefined, sym[0].toString(), undefined, getTypeNode(valueDecl), undefined)

                        })]
                        .filter(a => !!a) as ts.ClassElement[];
                }
            }
            catch (ex2) {
                //console.warn(ex2);
            }

            members = members
                .map(m => {
                    if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text == "initialize")
                        return factory.createConstructorDeclaration(m.modifiers, m.parameters, m.body);
                    return m;
                })
                .filter(a => {
                    if (ts.isConstructorDeclaration(a) && (!a.body || a.body.statements.length == 0))
                        return false;
                    //if (ts.isPropertyDeclaration(a) && !a.initializer)
                    //	return false;
                    return true;
                })
                .sort((a, b) => {
                    try {
                        if (ts.isPropertyDeclaration(a) && !ts.isPropertyDeclaration(b))
                            return -1;
                        if (ts.isPropertyDeclaration(b) && !ts.isPropertyDeclaration(a))
                            return 1;
                        if (ts.isConstructorDeclaration(a))
                            return -1;
                        if (ts.isConstructorDeclaration(b))
                            return 1;
                        if (a.kind == b.kind && !!a.name && !!b.name)
                            return a.name!.getText().localeCompare(b.name!.getText())
                    }
                    catch (ex) { }
                    return 0;
                })

            var newClass = factory.createClassDeclaration(
                //node.decorators,
                node.modifiers, node.name, node.typeParameters, node.heritageClauses, [...members]);
            //console.log(newClass);
            return ts.visitEachChild(newClass, visitor, context);
        }
        return ts.visitEachChild(node, visitor, context);

    };
    //if (isJS)
    //    sourceFile = factory.createSourceFile(sourceFile.statements, sourceFile.endOfFileToken as ts.EndOfFileToken, sourceFile.flags | ts.NodeFlags.JavaScriptFile);
    return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
};
function getFileBase(fileName: string) {
    return fileName.substring(0, fileName.lastIndexOf("."));
}

export default function (_program: ts.Program) {
    const transformerFactory = (context: ts.TransformationContext) => {
        return (sourceFile: ts.SourceFile) => {
           // return transformer(sourceFile, _program, context, true);
            var fileName = getFileBase(sourceFile!.fileName);
            var binding = getBindingTools([ts.createSourceFile(fileName + ".js", getSourceText(sourceFile), opts.target!, false, ts.ScriptKind.JS)], opts, false, context);
            //var binding = getBindingTools([ts.createSourceFile(fileName + ".ts", getSourceText(sourceFile), opts.target, false, ts.ScriptKind.TS)], opts, false, context);
            binding = getBindingTools(
                binding.program.getSourceFiles()
                    .map(sf => transformer(sf, binding.program, binding.context)),
                binding.program.getCompilerOptions(),
                false,
                binding.context
            )
            if (false) {
                try {
                    binding = fixFiles(binding, 80002);
                    binding = fixFiles(binding);
                    // return binding.program.getSourceFiles()[0];
                    var sourceFiles = binding.program.getSourceFiles().map(sf => {
                        var fileName = sf.fileName.substring(0, sf.fileName.lastIndexOf("."));
                        return ts.createSourceFile(fileName + ".ts", getSourceText(sf), opts.target!, false, ts.ScriptKind.TS);

                    });
                    binding = getBindingTools(sourceFiles, opts, false, context);
                    binding = fixFiles(binding, 80004);
                    //binding = fixFiles(binding, 2339);
                    binding = fixFiles(binding, 2304);

                    opts = {
                        "allowJs": true,
                        "checkJs": true,
                        "declaration": false,
                        "downlevelIteration": false,
                        "emitDecoratorMetadata": true,
                        "esModuleInterop": true,
                        "experimentalDecorators": true,
                        "importHelpers": false,
                        "isolatedModules": false,
                        "module": ts.ModuleKind.CommonJS,
                        "moduleResolution": ts.ModuleResolutionKind.Node16,
                        "lib": [
                            "ES5"
                        ],
                        "target": ts.ScriptTarget.ES5,
                        "strictNullChecks": false

                    };
                    /*	 sourceFiles = binding.program.getSourceFiles().map(sf => {
                              var fileName = sf.fileName.substring(0, sf.fileName.lastIndexOf("."));
                              var outputText = ts.transpileModule(getSourceText(sf), {
                                  "compilerOptions": opts,
                              }).outputText;
                              return ts.createSourceFile(fileName + ".js", outputText, opts.target, false, ts.ScriptKind.JS);
                          });
                          binding = getBindingTools(sourceFiles, opts, false, context);
                         binding = fixFiles(binding);*/
                    //console.log(binding.program.emit(sf))
                }
                catch (ex) {
                    console.error(ex);
                }
            }
            var sf = binding.program.getSourceFiles()[0];

            //var outputFile = binding.ls.getEmitOutput(sf.fileName, true, true).outputFiles[0];
            //sf = ts.createSourceFile(outputFile.name, outputFile.text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
            //console.log(sf);
            return sf;
        };
    };
    return transformerFactory;
}

export const type = 'program';