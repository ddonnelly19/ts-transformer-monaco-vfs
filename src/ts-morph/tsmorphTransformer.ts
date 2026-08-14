import { Project, SourceFile, Node, FileTextChanges, FormatCodeSettings, UserPreferences } from "ts-morph";
import ts from "typescript";
/**
 * Default transformer entry point consumed by both {@link runTransform} sandboxes.
 *
 * Receives the active ts-morph `Project` and applies all configured refactors
 * to the source files within it, mutating the project in place.
 *
 * @param project - The ts-morph `Project` containing the files to transform.
 */
export default (project: Project) => {
	var formatContext: FormatCodeSettings = {};
	var preferences: UserPreferences | undefined = {};

	/**
	 * Applies a batch of language-service file-text changes to the project and
	 * returns the updated `SourceFile` objects.
	 *
	 * Empty statements left behind by refactors are removed and the affected
	 * source files are refreshed.
	 *
	 * @param project - The ts-morph `Project` to update.
	 * @param changes - The file-text changes returned by a language-service edit.
	 * @returns Array of updated (and non-null) `SourceFile` instances.
	 */
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
	
	/**
	 * Iterates all descendant nodes of the given source file, queries the
	 * language service for applicable refactors, and applies the first matching
	 * set of edits.
	 *
	 * @param project - The ts-morph `Project` owning the file.
	 * @param sourceFilePath - VFS path of the file to refactor.
	 * @param kind - Optional refactor kind prefix filter (e.g. `"refactor.rewrite"`).
	 * @param name - Optional exact refactor name filter.
	 * @returns The (possibly modified) `SourceFile`.
	 */
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