/**
 * Generate ts.factory builder code from a TypeScript source file.
 *
 * Usage:
 *  npx tsx gen-factory-from-source.ts path/to/input.ts --out build-input.ts [--factoryParam]
 *
 * Notes:
 *  - Covers common TS constructs; logs warnings for unsupported nodes and skips them.
 *  - Extend switch-cases to support more SyntaxKinds as needed.
 */

import ts from "typescript";
import { getFlagNames } from "./utils";

export function getASTFactory(sourceFile: ts.SourceFile) {
	// ---------- Helpers ----------
	const K = ts.SyntaxKind;
	const kindName = <T extends ts.SyntaxKind>(k: T) => `${ts.SyntaxKind[k]}` as const;
	const q = (s: string) => JSON.stringify(s);

	let warnCount = 0;
	function warn(node: ts.Node, msg: string) {
		warnCount++;
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
		console.warn(
			`[warn] ${line + 1}:${character + 1} ${msg} (${kindName(node.kind)})`
		);
	}

	function emitArray<T>(arr: readonly T[] | undefined, emit: (t: T) => string): string {
		if (!arr || arr.length === 0) return "[]";
		return `[\n${arr.map((t) => "      " + emit(t)).join(",\n")}\n    ]`;
	}

	function emitMaybe<T>(v: T | undefined, f: (v: T) => string, fallback = "undefined") {
		return v ? f(v) : fallback;
	}

	function emitModifiers(node: ts.Node): string {
		const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
		if (!mods.length) return "undefined";
		const items = mods.map((m) => {
			if (ts.isDecorator(m)) {
				return emitDecorator(m);
			} else {
				return `factory.createModifier(ts.SyntaxKind.${kindName(m.kind)})`;
			}
		});
		return `[${items.join(", ")}]`;
	}

	function emitDecorator(dec: ts.Decorator): string {
		return `factory.createDecorator(${emitExpression(dec.expression)})`;
	}

	// ---------- Names & Identifiers ----------
	function emitIdentifier(id: ts.Identifier): string {
		return `factory.createIdentifier(${q(id.text)})`;
	}

	function emitMemberName(id: ts.MemberName): string {
		return ts.isIdentifier(id) ? emitIdentifier(id) : emitPrivateIdentifier(id);
	}

	function emitPrivateIdentifier(id: ts.PrivateIdentifier) {
		return `factory.createPrivateIdentifier(${q(id.text)})`;
	}

	function emitStringLiteral(id: ts.StringLiteralLike) {
		return `factory.createStringLiteral(${q(id.text)})`;
	}

	function emitIdentifierOrLiteral(id: ts.Identifier | ts.StringLiteralLike) {
		return ts.isIdentifier(id) ? emitIdentifier(id) : emitStringLiteral(id);
	}

	function emitPropertyName(name: ts.PropertyName): string {
		if (ts.isIdentifier(name)) return emitIdentifier(name);
		if (ts.isStringLiteral(name)) return `factory.createStringLiteral(${q(name.text)})`;
		if (ts.isNumericLiteral(name)) return `factory.createNumericLiteral(${q(name.text)})`;
		if (ts.isComputedPropertyName(name)) {
			return `factory.createComputedPropertyName(${emitExpression(name.expression)})`;
		}
		warn(name, "Unsupported property name; using identifier");
		return `factory.createIdentifier(${q(name.getText(sourceFile))})`;
	}

	function emitEntityName(n: ts.EntityName): string {
		if (ts.isIdentifier(n)) return emitIdentifier(n);
		return `factory.createQualifiedName(${emitEntityName(n.left)}, ${emitIdentifier(n.right)})`;
	}

	// ---------- Types ----------
	function emitTypeNode(t: ts.TypeNode | undefined): string {
		if (!t) return "undefined";

		switch (t.kind) {
			case K.AnyKeyword:
			case K.UnknownKeyword:
			case K.NumberKeyword:
			case K.BigIntKeyword:
			case K.ObjectKeyword:
			case K.BooleanKeyword:
			case K.StringKeyword:
			case K.SymbolKeyword:
			case K.VoidKeyword:
			case K.UndefinedKeyword:
			//case K.NullKeyword:
			case K.NeverKeyword:
				return `factory.createKeywordTypeNode(ts.SyntaxKind.${kindName(t.kind)})`;

			case K.TypeReference: {
				const tr = t as ts.TypeReferenceNode;
				const typeArgs = tr.typeArguments ? emitArray(tr.typeArguments, emitTypeNode) : "undefined";
				return `factory.createTypeReferenceNode(${emitEntityName(tr.typeName)}, ${typeArgs})`;
			}

			case K.ArrayType: {
				const at = t as ts.ArrayTypeNode;
				return `factory.createArrayTypeNode(${emitTypeNode(at.elementType)})`;
			}

			case K.TupleType: {
				const tt = t as ts.TupleTypeNode;
				return `factory.createTupleTypeNode(${emitArray(tt.elements, emitTypeNode)})`;
			}

			case K.UnionType: {
				const ut = t as ts.UnionTypeNode;
				return `factory.createUnionTypeNode(${emitArray(ut.types, emitTypeNode)})`;
			}

			case K.IntersectionType: {
				const it = t as ts.IntersectionTypeNode;
				return `factory.createIntersectionTypeNode(${emitArray(it.types, emitTypeNode)})`;
			}

			case K.ParenthesizedType: {
				const pt = t as ts.ParenthesizedTypeNode;
				return `factory.createParenthesizedType(${emitTypeNode(pt.type)})`;
			}

			case K.LiteralType: {
				const lt = t as ts.LiteralTypeNode;
				if (ts.isStringLiteral(lt.literal)) {
					return `factory.createLiteralTypeNode(factory.createStringLiteral(${q(lt.literal.text)}))`;
				}
				if (ts.isNumericLiteral(lt.literal)) {
					return `factory.createLiteralTypeNode(factory.createNumericLiteral(${q(lt.literal.text)}))`;
				}
				if (lt.literal.kind === K.TrueKeyword || lt.literal.kind === K.FalseKeyword) {
					return `factory.createLiteralTypeNode(factory.createIdentifier(${q(lt.literal.getText())}))`;
				}
				warn(lt, "Unsupported literal type; using 'any'");
				return `factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)`;
			}

			case K.TypeLiteral: {
				const tl = t as ts.TypeLiteralNode;
				return `factory.createTypeLiteralNode(${emitArray(tl.members, emitTypeElement)})`;
			}

			case K.FunctionType: {
				const ft = t as ts.FunctionTypeNode;
				const tps = ft.typeParameters ? emitArray(ft.typeParameters, emitTypeParameterDecl) : "undefined";
				return `factory.createFunctionTypeNode(${tps}, ${emitArray(ft.parameters, emitParameterDecl)}, ${emitTypeNode(ft.type)})`;
			}

			case K.TypePredicate: {
				const tp = t as ts.TypePredicateNode;
				const paramName = ts.isThisTypeNode(tp.parameterName)
					? "factory.createThisTypeNode()"
					: emitIdentifier(tp.parameterName as ts.Identifier);
				return `factory.createTypePredicateNode(${tp.assertsModifier ? "true" : "false"}, ${paramName}, ${emitTypeNode(tp.type)})`;
			}

			default:
				warn(t, "Unsupported TypeNode; using 'any'");
				return `factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)`;
		}
	}

	function emitTypeElement(el: ts.TypeElement): string {
		if (ts.isPropertySignature(el)) {
			return `factory.createPropertySignature(
      ${emitModifiers(el)},
      ${emitPropertyName(el.name)},
      ${el.questionToken ? "factory.createToken(ts.SyntaxKind.QuestionToken)" : "undefined"},
      ${emitTypeNode(el.type)}
    )`;
		}
		if (ts.isMethodSignature(el)) {
			const tps = el.typeParameters ? emitArray(el.typeParameters, emitTypeParameterDecl) : "undefined";
			return `factory.createMethodSignature(
      ${tps},
      ${emitPropertyName(el.name)},
      ${el.questionToken ? "factory.createToken(ts.SyntaxKind.QuestionToken)" : "undefined"},
      ${emitArray(el.parameters, emitParameterDecl)},
      ${emitTypeNode(el.type)}
    )`;
		}
		if (ts.isIndexSignatureDeclaration(el)) {
			return `factory.createIndexSignature(
      ${emitModifiers(el)},
      ${emitArray(el.parameters, emitParameterDecl)},
      ${emitTypeNode(el.type)}
    )`;
		}
		warn(el, "Unsupported TypeElement; using empty property");
		return `factory.createPropertySignature(undefined, factory.createIdentifier("unknown"), undefined, factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword))`;
	}

	function emitTypeParameterDecl(tp: ts.TypeParameterDeclaration): string {
		return `factory.createTypeParameterDeclaration(
    ${emitMaybe(tp.name, emitIdentifier)},
    ${emitMaybe(tp.constraint, emitTypeNode)},
    ${emitMaybe(tp.default, emitTypeNode)}
  )`;
	}

	// ---------- Parameters ----------
	function emitParameterDecl(p: ts.ParameterDeclaration): string {
		return `factory.createParameterDeclaration(
    ${emitModifiers(p)},
    ${p.dotDotDotToken ? "factory.createToken(ts.SyntaxKind.DotDotDotToken)" : "undefined"},
    ${emitPropertyName(p.name as ts.Identifier | ts.StringLiteral | ts.NumericLiteral | ts.ComputedPropertyName)},
    ${p.questionToken ? "factory.createToken(ts.SyntaxKind.QuestionToken)" : "undefined"},
    ${emitTypeNode(p.type)},
    ${emitMaybe(p.initializer, emitExpression)}
  )`;
	}

	// ---------- Expressions ----------
	function emitExpression(e: ts.Expression): string {
		switch (e.kind) {
			case K.Identifier:
				return emitIdentifier(e as ts.Identifier);
			case K.StringLiteral:
				return `factory.createStringLiteral(${q((e as ts.StringLiteral).text)})`;
			case K.NumericLiteral:
				return `factory.createNumericLiteral(${q((e as ts.NumericLiteral).text)})`;
			case K.TrueKeyword:
				return `factory.createTrue()`;
			case K.FalseKeyword:
				return `factory.createFalse()`;
			case K.NullKeyword:
				return `factory.createNull()`;
			case K.ObjectLiteralExpression: {
				const ol = e as ts.ObjectLiteralExpression;
				return `factory.createObjectLiteralExpression(${emitArray(ol.properties, emitObjectLiteralElement)}, true)`;
			}
			case K.ArrayLiteralExpression: {
				const al = e as ts.ArrayLiteralExpression;
				return `factory.createArrayLiteralExpression(${emitArray(al.elements, emitExpression)}, true)`;
			}
			case K.PropertyAccessExpression: {
				const pa = e as ts.PropertyAccessExpression;
				return `factory.createPropertyAccessExpression(${emitExpression(pa.expression)}, ${emitMemberName(pa.name)})`;
			}
			case K.ElementAccessExpression: {
				const ea = e as ts.ElementAccessExpression;
				return `factory.createElementAccessExpression(${emitExpression(ea.expression)}, ${emitExpression(ea.argumentExpression)})`;
			}
			case K.CallExpression: {
				const ce = e as ts.CallExpression;
				const typeArgs = ce.typeArguments ? emitArray(ce.typeArguments, emitTypeNode) : "undefined";
				return `factory.createCallExpression(${emitExpression(ce.expression)}, ${typeArgs}, ${emitArray(ce.arguments, emitExpression)})`;
			}
			case K.NewExpression: {
				const ne = e as ts.NewExpression;
				const typeArgs = ne.typeArguments ? emitArray(ne.typeArguments, emitTypeNode) : "undefined";
				return `factory.createNewExpression(${emitExpression(ne.expression)}, ${typeArgs}, ${emitArray(ne.arguments, emitExpression)})`;
			}
			case K.ArrowFunction: {
				const af = e as ts.ArrowFunction;
				const tps = af.typeParameters ? emitArray(af.typeParameters, emitTypeParameterDecl) : "undefined";
				return `factory.createArrowFunction(
        ${emitModifiers(af)},
        ${tps},
        ${emitArray(af.parameters, emitParameterDecl)},
        ${emitTypeNode(af.type)},
        ${af.equalsGreaterThanToken ? "factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken)" : "undefined"},
        ${emitConciseBody(af.body)}
      )`;
			}
			case K.BinaryExpression: {
				const be = e as ts.BinaryExpression;
				return `factory.createBinaryExpression(${emitExpression(be.left)}, factory.createToken(ts.SyntaxKind.${kindName(be.operatorToken.kind)}), ${emitExpression(be.right)})`;
			}
			case K.PrefixUnaryExpression: {
				const pe = e as ts.PrefixUnaryExpression;
				return `factory.createPrefixUnaryExpression(ts.SyntaxKind.${kindName(pe.operator)}, ${emitExpression(pe.operand)})`;
			}
			case K.PostfixUnaryExpression: {
				const po = e as ts.PostfixUnaryExpression;
				return `factory.createPostfixUnaryExpression(${emitExpression(po.operand)}, ts.SyntaxKind.${kindName(po.operator)})`;
			}
			case K.TemplateExpression: {
				const te = e as ts.TemplateExpression;
				return `factory.createTemplateExpression(
        ${emitTemplateHead(te.head)},
        ${emitArray(te.templateSpans, emitTemplateSpan)}
      )`;
			}
			case K.NoSubstitutionTemplateLiteral: {
				const tl = e as ts.NoSubstitutionTemplateLiteral;
				return `factory.createNoSubstitutionTemplateLiteral(${q(tl.text)})`;
			}
			case K.ConditionalExpression: {
				const c = e as ts.ConditionalExpression;
				return `factory.createConditionalExpression(${emitExpression(c.condition)}, factory.createToken(ts.SyntaxKind.QuestionToken), ${emitExpression(c.whenTrue)}, factory.createToken(ts.SyntaxKind.ColonToken), ${emitExpression(c.whenFalse)})`;
			}
			case K.AsExpression: {
				const ae = e as ts.AsExpression;
				return `factory.createAsExpression(${emitExpression(ae.expression)}, ${emitTypeNode(ae.type)})`;
			}
			case K.NonNullExpression: {
				const nn = e as ts.NonNullExpression;
				return `factory.createNonNullExpression(${emitExpression(nn.expression)})`;
			}
			case K.ParenthesizedExpression: {
				const pe = e as ts.ParenthesizedExpression;
				return `factory.createParenthesizedExpression(${emitExpression(pe.expression)})`;
			}
			default:
				warn(e, "Unsupported Expression; using identifier");
				return `factory.createIdentifier(${q(e.getText(sourceFile))})`;
		}
	}

	function emitConciseBody(body: ts.ConciseBody): string {
		return ts.isBlock(body) ? emitBlock(body) : emitExpression(body);
	}

	function emitTemplateHead(h: ts.TemplateHead): string {
		return `factory.createTemplateHead(${q(h.text)})`;
	}
	function emitTemplateSpan(s: ts.TemplateSpan): string {
		const tail = s.literal.kind === K.TemplateTail
			? `factory.createTemplateTail(${q(s.literal.text)})`
			: `factory.createTemplateMiddle(${q(s.literal.text)})`;
		return `factory.createTemplateSpan(${emitExpression(s.expression)}, ${tail})`;
	}

	function emitObjectLiteralElement(p: ts.ObjectLiteralElementLike): string {
		if (ts.isPropertyAssignment(p)) {
			return `factory.createPropertyAssignment(${emitPropertyName(p.name)}, ${emitExpression(p.initializer)})`;
		}
		if (ts.isShorthandPropertyAssignment(p)) {
			return `factory.createShorthandPropertyAssignment(${emitIdentifier(p.name)}, ${p.objectAssignmentInitializer ? emitExpression(p.objectAssignmentInitializer) : "undefined"})`;
		}
		if (ts.isSpreadAssignment(p)) {
			return `factory.createSpreadAssignment(${emitExpression(p.expression)})`;
		}
		if (ts.isMethodDeclaration(p)) {
			return emitMethodDeclaration(p);
		}
		warn(p, "Unsupported object literal element; using empty assignment");
		return `factory.createPropertyAssignment(factory.createIdentifier("unknown"), factory.createIdentifier("undefined"))`;
	}

	// ---------- Statements ----------
	function emitStatement(s: ts.Statement): string {
		switch (s.kind) {
			case K.VariableStatement:
				return emitVariableStatement(s as ts.VariableStatement);
			case K.FunctionDeclaration:
				return emitFunctionDeclaration(s as ts.FunctionDeclaration);
			case K.ExpressionStatement:
				return `factory.createExpressionStatement(${emitExpression((s as ts.ExpressionStatement).expression)})`;
			case K.ReturnStatement: {
				const rs = s as ts.ReturnStatement;
				return `factory.createReturnStatement(${emitMaybe(rs.expression, emitExpression)})`;
			}
			case K.IfStatement: {
				const is = s as ts.IfStatement;
				return `factory.createIfStatement(${emitExpression(is.expression)}, ${emitStatementOrBlock(is.thenStatement)}, ${emitMaybe(is.elseStatement, emitStatementOrBlock)})`;
			}
			case K.ForStatement: {
				const fs = s as ts.ForStatement;
				return `factory.createForStatement(${emitMaybe(fs.initializer as any, emitForInitializer)}, ${emitMaybe(fs.condition, emitExpression)}, ${emitMaybe(fs.incrementor, emitExpression)}, ${emitStatementOrBlock(fs.statement)})`;
			}
			case K.ForOfStatement: {
				const fo = s as ts.ForOfStatement;
				return `factory.createForOfStatement(${emitModifiers(fo)}, ${emitForInitializer(fo.initializer)}, ${emitExpression(fo.expression)}, ${emitStatementOrBlock(fo.statement)})`;
			}
			case K.Block:
				return emitBlock(s as ts.Block);
			case K.ImportDeclaration:
				return emitImportDeclaration(s as ts.ImportDeclaration);
			case K.ExportDeclaration:
				return emitExportDeclaration(s as ts.ExportDeclaration);
			case K.ClassDeclaration:
				return emitClassDeclaration(s as ts.ClassDeclaration);
			case K.InterfaceDeclaration:
				return emitInterfaceDeclaration(s as ts.InterfaceDeclaration);
			case K.TypeAliasDeclaration:
				return emitTypeAliasDeclaration(s as ts.TypeAliasDeclaration);
			case K.ModuleDeclaration:
				return emitModuleStatement(s as ts.ModuleDeclaration);
			default:
				warn(s, "Unsupported Statement; inserting empty statement");
				return `factory.createEmptyStatement()`;
		}
	}

	function emitModuleBody(s: ts.ModuleBody): string {
		return ts.isModuleBlock(s) ? `factory.createModuleBlock(${emitArray(s.statements, emitStatement)})` :
			ts.isModuleDeclaration(s) ? emitModuleStatement(s) :
				emitIdentifier(s);
	}

	function emitModuleStatement(s: ts.ModuleDeclaration) {
		return `factory.createModuleDeclaration(
    ${emitModifiers(s)},
	${emitIdentifierOrLiteral(s.name)},
    ${s.body ? emitModuleBody(s.body) : "undefined"},
	${emitNodeFlags(s.flags)}
)`;
	}

	function emitStatementOrBlock(s: ts.Statement): string {
		return ts.isBlock(s) ? emitBlock(s) : emitStatement(s);
	}

	function emitForInitializer(init: ts.ForInitializer | undefined): string {
		if (!init) return "undefined";
		if (ts.isVariableDeclarationList(init)) {
			return emitVariableDeclarationList(init);
		}
		return emitExpression(init as ts.Expression);
	}

	function emitBlock(b: ts.Block): string {
		return `factory.createBlock(${emitArray(b.statements, emitStatement)}, ${b.multiLine})`;
	}

	function emitVariableStatement(vs: ts.VariableStatement): string {
		return `factory.createVariableStatement(
    ${emitModifiers(vs)},
    ${emitVariableDeclarationList(vs.declarationList)}
  )`;
	}

	function emitNodeFlags(flags: ts.NodeFlags) {
		return getFlagNames(flags, ts.NodeFlags)
			.map(name => `ts.NodeFlags.${name}`)
			.join(" | ");
	}

	function emitVariableDeclarationList(vdl: ts.VariableDeclarationList): string {
		const flags =
			(vdl.flags & ts.NodeFlags.Const) ? "ts.NodeFlags.Const" :
				(vdl.flags & ts.NodeFlags.Let) ? "ts.NodeFlags.Let" :
					"ts.NodeFlags.None";
		return `factory.createVariableDeclarationList(${emitArray(vdl.declarations, emitVariableDeclaration)}, ${flags})`;
	}

	function emitVariableDeclaration(vd: ts.VariableDeclaration): string {
		const name = ts.isIdentifier(vd.name)
			? emitIdentifier(vd.name)
			: `factory.createIdentifier(${q(vd.name.getText(sourceFile))})`;
		return `factory.createVariableDeclaration(
    ${name},
    ${vd.exclamationToken ? "factory.createToken(ts.SyntaxKind.ExclamationToken)" : "undefined"},
    ${emitTypeNode(vd.type)},
    ${emitMaybe(vd.initializer, emitExpression)}
  )`;
	}

	function emitFunctionDeclaration(fd: ts.FunctionDeclaration): string {
		const tps = fd.typeParameters ? emitArray(fd.typeParameters, emitTypeParameterDecl) : "undefined";
		const body = fd.body ? emitBlock(fd.body) : "undefined";
		return `factory.createFunctionDeclaration(
    ${emitModifiers(fd)},
    ${fd.asteriskToken ? "factory.createToken(ts.SyntaxKind.AsteriskToken)" : "undefined"},
    ${emitMaybe(fd.name, emitIdentifier)},
    ${tps},
    ${emitArray(fd.parameters, emitParameterDecl)},
    ${emitTypeNode(fd.type)},
    ${body}
  )`;
	}

	function emitMethodDeclaration(md: ts.MethodDeclaration): string {
		const tps = md.typeParameters ? emitArray(md.typeParameters, emitTypeParameterDecl) : "undefined";
		const body = md.body ? emitBlock(md.body) : "undefined";
		return `factory.createMethodDeclaration(
    ${emitModifiers(md)},
    ${md.asteriskToken ? "factory.createToken(ts.SyntaxKind.AsteriskToken)" : "undefined"},
    ${md.name ? emitPropertyName(md.name) : "factory.createIdentifier('method')"},
    ${md.questionToken ? "factory.createToken(ts.SyntaxKind.QuestionToken)" : "undefined"},
    ${tps},
    ${emitArray(md.parameters, emitParameterDecl)},
    ${emitTypeNode(md.type)},
    ${body}
  )`;
	}

	function emitConstructorDeclaration(cd: ts.ConstructorDeclaration): string {
		return `factory.createConstructorDeclaration(
    ${emitModifiers(cd)},
    ${emitArray(cd.parameters, emitParameterDecl)},
    ${cd.body ? emitBlock(cd.body) : "undefined"}
  )`;
	}

	function emitPropertyDeclaration(pd: ts.PropertyDeclaration): string {
		return `factory.createPropertyDeclaration(
    ${emitModifiers(pd)},
    ${emitPropertyName(pd.name)},
    ${pd.questionToken ? "factory.createToken(ts.SyntaxKind.QuestionToken)" : "undefined"},
    ${emitTypeNode(pd.type)},
    ${emitMaybe(pd.initializer, emitExpression)}
  )`;
	}

	function emitHeritageClauses(h: readonly ts.HeritageClause[] | undefined): string {
		if (!h || h.length === 0) return "undefined";
		return `[
    ${h
				.map(
					(hc) => `factory.createHeritageClause(
      ts.SyntaxKind.${kindName(hc.token)},
      ${emitArray(hc.types, (t) =>
						`factory.createExpressionWithTypeArguments(${emitExpression(t.expression)}, ${t.typeArguments ? emitArray(t.typeArguments, emitTypeNode) : "undefined"})`
					)}
    )`
				)
				.join(",\n")}
  ]`;
	}

	function emitClassDeclaration(cd: ts.ClassDeclaration): string {
		return `factory.createClassDeclaration(
    ${emitModifiers(cd)},
    ${emitMaybe(cd.name, emitIdentifier)},
    ${cd.typeParameters ? emitArray(cd.typeParameters, emitTypeParameterDecl) : "undefined"},
    ${emitHeritageClauses(cd.heritageClauses)},
    ${emitArray(cd.members, (m) => {
			if (ts.isConstructorDeclaration(m)) return emitConstructorDeclaration(m);
			if (ts.isMethodDeclaration(m)) return emitMethodDeclaration(m);
			if (ts.isPropertyDeclaration(m)) return emitPropertyDeclaration(m);
			warn(m, "Unsupported class member; using property");
			return `factory.createPropertyDeclaration(undefined, factory.createIdentifier("unknown"), undefined, undefined, undefined)`;
		})}
  )`;
	}

	function emitInterfaceDeclaration(id: ts.InterfaceDeclaration): string {
		const tps = id.typeParameters ? emitArray(id.typeParameters, emitTypeParameterDecl) : "undefined";
		return `factory.createInterfaceDeclaration(
    ${emitModifiers(id)},
    ${emitIdentifier(id.name)},
    ${tps},
    ${emitHeritageClauses(id.heritageClauses)},
    ${emitArray(id.members, emitTypeElement)}
  )`;
	}

	function emitTypeAliasDeclaration(td: ts.TypeAliasDeclaration): string {
		const tps = td.typeParameters ? emitArray(td.typeParameters, emitTypeParameterDecl) : "undefined";
		return `factory.createTypeAliasDeclaration(
    ${emitModifiers(td)},
    ${emitIdentifier(td.name)},
    ${tps},
    ${emitTypeNode(td.type)}
  )`;
	}

	function emitImportDeclaration(id: ts.ImportDeclaration): string {
		const ic = id.importClause;
		const importClause = ic
			? `factory.createImportClause(${ic.isTypeOnly ? "true" : "false"},
        ${ic.name ? emitIdentifier(ic.name) : "undefined"},
        ${ic.namedBindings ? emitNamedBindings(ic.namedBindings) : "undefined"})`
			: "undefined";

		return `factory.createImportDeclaration(
    ${emitModifiers(id)},
    ${importClause},
    factory.createStringLiteral(${q((id.moduleSpecifier as ts.StringLiteral).text)}),
    ${id.assertClause ? emitAssertClause(id.assertClause) : "undefined"}
  )`;
	}

	function emitNamedBindings(nb: ts.NamedImportBindings): string {
		if (ts.isNamespaceImport(nb)) {
			return `factory.createNamespaceImport(${emitIdentifier(nb.name)})`;
		} else {
			const els = (nb as ts.NamedImports).elements;
			return `factory.createNamedImports(${emitArray(els, (e) =>
				`factory.createImportSpecifier(${e.isTypeOnly ? "true" : "false"}, ${e.propertyName ? emitIdentifierOrLiteral(e.propertyName) : "undefined"}, ${emitIdentifier(e.name)})`
			)})`;
		}
	}

	function emitExportDeclaration(ed: ts.ExportDeclaration): string {
		const ns = ed.exportClause && ts.isNamespaceExport(ed.exportClause)
			? `factory.createNamespaceExport(${emitIdentifierOrLiteral(ed.exportClause.name)})`
			: ed.exportClause && ts.isNamedExports(ed.exportClause)
				? `factory.createNamedExports(${emitArray(ed.exportClause.elements, (e) =>
					`factory.createExportSpecifier(${e.isTypeOnly ? "true" : "false"}, ${e.propertyName ? emitIdentifierOrLiteral(e.propertyName) : "undefined"}, ${emitIdentifierOrLiteral(e.name)})`
				)})`
				: "undefined";

		return `factory.createExportDeclaration(
    ${emitModifiers(ed)},
    ${ed.isTypeOnly ? "true" : "false"},
    ${ns},
    ${ed.moduleSpecifier ? `factory.createStringLiteral(${q((ed.moduleSpecifier as ts.StringLiteral).text)})` : "undefined"},
    ${ed.assertClause ? emitAssertClause(ed.assertClause) : "undefined"}
  )`;
	}

	function emitAssertClause(ac: ts.AssertClause): string {
		return `factory.createAssertClause(${emitArray(ac.elements, (e) =>
			`factory.createAssertEntry(${emitIdentifierOrLiteral(e.name)}, ${emitExpression(e.value)})`
		)}, ${ac.multiLine ? "true" : "false"})`;
	}

	// ---------- SourceFile ----------
	function emitSourceFile(sf: ts.SourceFile) {
		const stmts = emitArray(sf.statements, emitStatement);
		var source = `factory.createSourceFile(
    ${stmts},
    factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None
  )`;
		var fSf = ts.createSourceFile("dummy.ts", source, ts.ScriptTarget.ESNext, true);
		return ts.createPrinter({}).printFile(fSf);

	}

	return emitSourceFile(sourceFile);
}