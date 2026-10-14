import ts from "typescript";
import { applyRefactors, createTSMorphTransform } from "./utils";

const xformer: (program: ts.Program) => ts.TransformerFactory<ts.SourceFile> = (_program) =>
	createTSMorphTransform((sourceFile) => applyRefactors(sourceFile, "refactor.rewrite.string"));

export default ({ program }: { program: ts.Program }) => xformer(program);
