import { Project, SourceFile, Node, FileTextChanges, FormatCodeSettings, UserPreferences } from "ts-morph";
import ts from "typescript";
export default (project: Project) => {
	var formatContext: FormatCodeSettings = {};
	var preferences: UserPreferences | undefined = {};

	function applyFileChanges(project: Project, changes: FileTextChanges[]) {
		return Array.from(
			changes.reduce<Set<string>>((state, curr) => {
				state.add(curr.applyChanges({ overwrite: true })?.getFilePath() || "");
				return state;
			}, new Set())
		)
			.map((filePath) => project.getSourceFile(filePath))
			.filter((a) => !!a)
			.map((sf) => {
				var x = sf.getDescendantsOfKind(ts.SyntaxKind.EmptyStatement);
				if (x.length > 0) {
					x.forEach((a) => a);
					sf.forget();
					//sf = _this.getSourceFile(sf.getFilePath())!;
				}
				return sf;
			});
	}
	
	function applyRefactors(
		project: Project,
		sourceFilePath: string,
		kind?: string,
		name?: string
	): SourceFile {
		
		var sourceFile = project.getSourceFile(sourceFilePath)!;
		/*if (!_this.parent) {
			var path = sourceFile.getFilePath();
			var project = createSourceFileProject(sourceFile, _this, {
				..._this["_context"],
				compilerOptions: {
					..._this.getCompilerOptions(),
					rootDirs: undefined
				}
			});
			var newSf = project.applyRefactors(project.getSourceFile(path)!.getFilePath(), kind, name);
			return !!newSf ? _this.createSourceFile(path, newSf.getFullText(), { overwrite: true }) : _this.getSourceFile(path)!
		}*/
		var refactors: ts.ApplicableRefactorInfo[] = [];
		function isApplicable(node: Node) {
			if (
				kind == "refactor.rewrite.string" &&
				(Node.isStringLiteral(node) ||
					Node.isSourceFile(node) ||
					Node.isSyntaxList(node))
			)
				return false;
			var lsh = project.getLanguageService().compilerObject as ts.LanguageService;
			refactors = refactors.concat(
				lsh.getApplicableRefactors(
						node.getSourceFile()?.getFilePath() || sourceFilePath,
						node.compilerNode,
						preferences,
						"invoked",
						kind,
						false
					)
					.filter((info) => (!!name ? info.name == name : true))
					.filter((info) =>
						!!kind
							? info.actions.some((action) => action.kind?.startsWith(kind))
							: true
					)
					.filter(
						(info) =>
							!(info.name == "Extract type" && Node.isBooleanKeyword(node))
					)
			);
			return refactors.length > 0;
		}

		try {
			let node = sourceFile.getFirstDescendant(isApplicable);
			if (!!node && refactors.length > 0) {
				var changes = refactors
					.flatMap((refactor) =>
						refactor.actions
							.filter((action) =>
								!!kind ? action.kind?.startsWith(kind) : true
							)
							.flatMap((action) =>
								project
									.getLanguageService()
									.getEditsForRefactor(
										node.getSourceFile(),
										formatContext,
										node,
										refactor.name,
										action.name,
										preferences
									)
									?.getEdits()
							)
					)
					.filter((a) => !!a);
				//console.log(`applying refactors "${kind}" on (${node.getKindName()}) "${node.getFullText()}" for ${sourceFile.getFilePath()}: ${changes.length}`)
				applyFileChanges(project, changes);
				return applyRefactors(project, sourceFilePath, kind, name);
			}
		} catch (ex) {
			console.error(
				`error applying refactors "${kind}" for ${sourceFilePath}`,
				ex
			);
		}
		return project.getSourceFile(sourceFilePath)!;
	}

	applyRefactors(project, "input.js", "refactor.rewrite.string")
}