import * as monaco from 'monaco-editor'
import { useRef, useState } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { configureMonacoTs } from './monacoTsConfig'
import './styles.css'
import { editor } from 'monaco-editor';
import { runTransform } from './ts/transformSandbox'

const SAMPLE_SOURCE = `// Paste TypeScript here\nexport function add(a: number, b: number) {\n  if (a == null || b != null) { /* demo */ }\n  return a + b;\n}\nconsole.log(add(1, 2));\n`;

const jsdoc = `/** 
({ host, program, sourceFile }: {
    host: import("typescript").CompilerHost;
    program: import("typescript").Program;
    sourceFile: import("typescript").SourceFile;
}) => ts.SourceFile
*/\n`

const SAMPLE_TRANSFORM = `export default (
	ts: typeof import("typescript"),
	env: {
		sys: import("typescript").System;
		languageService: import("typescript").LanguageService;
		getSourceFile: (fileName: string) => import("typescript").SourceFile | undefined;
		createFile: (fileName: string, content: string) => void;
		updateFile: (fileName: string, content: string, replaceTextSpan?: import("typescript").TextSpan) => void;
		deleteFile: (fileName: string) => void;
	}) => {
	const tr = ts.transform(env.getSourceFile("input.ts")!, [
		(context) => {
			const { factory } = context;
			const visit: import("typescript").Visitor = (node) => {
				if (ts.isBinaryExpression(node)) {
					const op = node.operatorToken.kind;
					if (op === ts.SyntaxKind.EqualsEqualsToken) {
						return factory.updateBinaryExpression(node, node.left, factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken), node.right);
					} else if (op === ts.SyntaxKind.ExclamationEqualsToken) {
						return factory.updateBinaryExpression(node, node.left, factory.createToken(ts.SyntaxKind.ExclamationEqualsEqualsToken), node.right);
					}
				}
				return ts.visitEachChild(node, visit, context);
			};
			return (sf) => (ts.visitNode(sf, visit) || sf) as typeof sf
		}
	]);
	
	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })	
	tr.transformed.forEach(sf => env.updateFile(sf.fileName, printer.printFile(sf)));
	tr.dispose();
}`;

configureMonacoTs(monaco);

function useMarkers() {
	//const monaco = useMonaco();
	const setMarkers = (model: editor.ITextModel, errors: {
		message: string;
		error: any;
	}[], positions: { line: number; column: number; message: string }[]) => {
		if (!monaco || !model)
			return;
		const markers: any[] = positions.length > 0
			? positions.map(p => ({
				severity: monaco!.MarkerSeverity.Error,
				message: p.message,
				startLineNumber: p.line,
				startColumn: p.column,
				endLineNumber: p.line,
				endColumn: p.column + 1,
			}))
			: errors.map(msg => ({
				severity: monaco!.MarkerSeverity.Error,
				message: `${msg.message}: ${msg.error}`,
				startLineNumber: 1,
				startColumn: 1,
				endLineNumber: 1,
				endColumn: 1,
			}));
		monaco!.editor.setModelMarkers(model, 'ts-transform', markers);
	};
	return { setMarkers };
}

export default function App() {
	const [source, setSource] = useState(SAMPLE_SOURCE)
	const [transform, setTransform] = useState(SAMPLE_TRANSFORM)
	//const [transformedTs, setTransformedTs] = useState('')
	const [emittedJs, setEmittedJs] = useState('')
	const [dts, setDts] = useState('')
	const [errors, setErrors] = useState<string[]>([])
	const [positions, setPositions] = useState<{ line: number; column: number; message: string }[]>([])
	const [isRunning, setIsRunning] = useState(false)
	const runId = useRef(0)
	const diffModelRef = useRef<editor.IDiffEditorModel>(null);
	//const sourceModelRef = useRef<editor.ITextModel>(null)
	const transformModelRef = useRef<editor.ITextModel>(null)
	const { setMarkers } = useMarkers()

	const handleRunTransform = async () => {
		setIsRunning(true)
		const id = ++runId.current
		try {
			var inputFileName = diffModelRef.current!.original.getLanguageId() == "typescript" ? "input.ts" : "input.js"
			var source = diffModelRef.current!.original.getValue();
			var transformCode = transformModelRef.current!.getValue();
			const result = await runTransform({
				inputFileName,
				source,
				transformCode,
				compilerOptions: monaco.typescript.typescriptDefaults.getCompilerOptions()
			})
			if (id === runId.current) {
				diffModelRef.current?.modified.setValue(result.transformedTs);
				//setTransformedTs(result.transformedTs)
				setEmittedJs(result.emittedJs)
				setDts(result.dts)
				setErrors(result.errors.map(e => `${e.message}: ${e.error}`))
				setPositions(result.errorPositions || [])
				if (!!transformModelRef.current) {
					setMarkers(transformModelRef.current, result.errors, result.errorPositions || [])
				}
			}
		} catch (e: any) {
			console.error(e);
			setErrors([`${e}`])
		} finally {
			setIsRunning(false)
		}
	}

	return (
		<div className="app">
			<header>
				<h1>Live TypeScript Transformer (Compiler API + VFS + Monaco)</h1>
				<div className="meta">
					<span>TS IntelliSense: enabled</span>
				</div>
			</header>

			<div style={{ marginBottom: '1rem' }}>
				<button
					type='submit'
					onClick={handleRunTransform}
					disabled={isRunning}
					style={{
						padding: '0.5rem 1rem',
						fontSize: '1rem',
						cursor: isRunning ? 'not-allowed' : 'pointer',
						opacity: isRunning ? 0.6 : 1
					}}
				>
					{isRunning ? 'Running...' : 'Run Transform'}
				</button>
				<label htmlFor='language'>Javascript? </label>
				<input
					type='checkbox'
					onChange={(event) => {
						if (diffModelRef.current) {
							//	var sourceEditor = editor.getEditors().find(e => e.getModel()?.id == sourceModelRef.current!.id);
							var language = event.currentTarget.checked ? "javascript" : "typescript";
							editor.setModelLanguage(diffModelRef.current.original, language);
							editor.setModelLanguage(diffModelRef.current.modified, language);
							/*sourceEditor.setModel(
								editor.createModel(sourceModelRef.current.getValue(), 
								event.currentTarget.checked ? "javascript" : "typescript",
								monaco.Uri.parse(event.currentTarget.checked ? "file:///input.js" : "file:///input.ts")
							))*/
							//sourceModelRef.current = sourceEditor.getModel();

						}
					}}
					defaultChecked={true}
					title='Javascript?:'
					name='language'
				></input>
			</div>

			<main className="grid">
				<section className="pane">
					<h2>Source (.ts)</h2>
					<DiffEditor
						height="100%"
						theme="vs-dark"
						originalLanguage='javascript'
						modifiedLanguage='javascript'
						original={source}
						originalModelPath='file:///index.js'
						modifiedModelPath='file:///transformed.js'
						options={
							{
								fontSize: 14,
								minimap: { enabled: false },
								automaticLayout: true,
								originalEditable: true
							}}
						onMount={(editor) => {
							diffModelRef.current = editor.getModel()
						}}
					/>
					{/* <Editor height="100%" theme="vs-dark" defaultLanguage="javascript"
						value={source}
						defaultPath='file:///index.js'
						onChange={(v) => setSource(v ?? '')}
						onMount={(editor) => {
							sourceModelRef.current = editor.getModel();
						}}
						options={
							{
								fontSize: 14,
								minimap: { enabled: false },
								automaticLayout: true,
							}} /> */}
				</section>
				<section className="pane">
					<h2>Transform (TypeScript using TS API)</h2>
					<Editor height="100%" theme="vs-dark" defaultLanguage="typescript"
						defaultPath='file:///transform.ts'
						value={transform}
						onChange={(v) => setTransform(`${v ?? jsdoc}`)}
						onMount={(editor) => {
							transformModelRef.current = editor.getModel()
						}}
						options={{
							fontSize: 14,
							minimap: { enabled: false },
							automaticLayout: true,
						}}
					/>
				</section>

				{/* <section className="pane output">
					<h2>Transformed (.ts)</h2>
					<Editor height="100%" theme="vs-dark" defaultLanguage="javascript"
						value={transformedTs}
						defaultPath='file:///transformed.js'
						options={{ fontSize: 14, readOnly: true, minimap: { enabled: false }, automaticLayout: true }} />
				</section> */}
				<section className="pane output">
					<h2>Emitted (.js)</h2>
					<Editor height="100%" theme="vs-dark" defaultLanguage="javascript"
						defaultPath='file:///emitted.js'
						value={emittedJs}
						options={{ fontSize: 14, readOnly: true, minimap: { enabled: false }, automaticLayout: true }} />
				</section>
				<section className="pane output">
					<h2>Definition (.d.ts)</h2>
					<Editor height="100%" theme="vs-dark" defaultLanguage="typescript"
						defaultPath='file:///emitted.d.ts'
						value={dts}
						options={{ fontSize: 14, readOnly: true, minimap: { enabled: false }, automaticLayout: true }} />
				</section>
			</main>

			<footer>
				{errors.length > 0 && (
					<div className="errors">
						<strong>Errors</strong>
						<ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
					</div>
				)}
				<small>Powered by TypeScript Compiler API + VFS and Monaco Editor.</small>
			</footer>
		</div>
	)
}
