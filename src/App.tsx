import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import monaco from './monacoInit'
import { configureMonacoTs } from './monacoTsConfig'
import './styles.css'
import './components/customScriptManager.css'
import { editor } from 'monaco-editor';
import { runTransform } from './ts/transformSandbox'
import fs from './localFsBrowser'
import { getStorageItem, setStorageItem } from './storage'
import { CustomScriptManager } from './components/CustomScriptManager'
import { type CustomScript } from './transformScriptManager'
import transformScript from "../storage/transformer.ts?raw";
import sourceScript from "../storage/source.ts?raw";

/** Lazily cached promise for the TypeScript internal module. Ensures it is loaded only once. */
let tsModulePromise: Promise<typeof import('typescript')> | null = null

/** Returns the singleton TypeScript internal module, loading it on first call. */
async function getTsModule() {
	if (!tsModulePromise) {
		tsModulePromise = import('typescript')
	}
	return tsModulePromise
}

const configPath = "./storage/config.json";
const transformsDirPath = "./storage/transformers";
const activeTransformPath = "./storage/active-transform.txt";
const runtimeTransformPath = "./storage/transformer.ts";
const isJavaScriptStorageKey = 'ts-transformer:isJavaScript'
const activeOutputTabStorageKey = 'ts-transformer:activeOutputTab'
const selectedTransformFileStorageKey = 'ts-transformer:selectedTransformFile'
const showCompilerOptionsStorageKey = 'ts-transformer:showCompilerOptions'
const jsdoc = `/** 
({ host, program, sourceFile }: {
    host: import("typescript").CompilerHost;
    program: import("typescript").Program;
    sourceFile: import("typescript").SourceFile;
}) => ts.SourceFile
*/\n`

configureMonacoTs(monaco);

/**
 * Converts raw compiler options (numeric enum values or JSON string) into
 * typed {@link import('typescript').CompilerOptions} using
 * the runtime TypeScript module's enum members.
 *
 * @param options - Compiler options object or JSON string.
 * @param ts - The runtime TypeScript module used to resolve enum values.
 * @returns Partially-typed compiler options with numeric enum values replaced by string keys.
 */
function convertCompilerOptions(
	options: any,
	ts: typeof import('typescript')
): Partial<import('typescript').CompilerOptions> {
	if (typeof options == "string")
		options = JSON.parse(options);
	// Use the runtime TypeScript enums from the dynamically loaded module.
	const converted: any = { ...options };

	// Convert target
	if (typeof options.target === 'number') {
		converted.target = ts.ScriptTarget[options.target as keyof typeof ts.ScriptTarget];
	}

	// Convert module
	if (typeof options.module === 'number') {
		converted.module = ts.ModuleKind[options.module as keyof typeof ts.ModuleKind];
	}

	// Convert moduleResolution
	if (typeof options.moduleResolution === 'number') {
		converted.moduleResolution = ts.ModuleResolutionKind[options.moduleResolution as keyof typeof ts.ModuleResolutionKind];
	}

	// Convert jsx
	if (typeof options.jsx === 'number') {
		converted.jsx = ts.JsxEmit[options.jsx as keyof typeof ts.JsxEmit];
	}

	// Convert newLine
	if (typeof options.newLine === 'number') {
		converted.newLine = ts.NewLineKind[options.newLine as keyof typeof ts.NewLineKind];
	}

	return converted;
}

/**
 * Custom hook that provides a `setMarkers` helper for surfacing compile
 * errors as Monaco editor markers on a given text model.
 */
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

/**
 * Loads compiler options from the config file on disk.
 * Falls back to Monaco's current TypeScript defaults if the file is missing or empty.
 *
 * @returns JSON string of compiler options.
 */
async function loadConfigFile() {
	try {
		var _compilerOptions = await fs.readFile(configPath);
		if (_compilerOptions == "")
			throw new Error("empty file");
		return _compilerOptions;
	} catch (ex) {
		return JSON.stringify(monaco.typescript.typescriptDefaults.getCompilerOptions(), null, "\t")
	}
}

var compilerOptions = await loadConfigFile()

/** Root application component for the Live TypeScript Transformer UI. */
export default function App() {
	const [source, setSource] = useState(sourceScript)
	const [transformCode, setTransform] = useState(transformScript)
	const [transformFiles, setTransformFiles] = useState<string[]>([])
	const [selectedTransformFile, setSelectedTransformFile] = useState(() => getStorageItem(selectedTransformFileStorageKey))
	const [transformedTs, setTransformedTs] = useState('')
	const [emittedJs, setEmittedJs] = useState('')
	const [dts, setDts] = useState('')
	const [structure, setStructure] = useState('')
	const [errors, setErrors] = useState<string[]>([])
	const [positions, setPositions] = useState<{ line: number; column: number; message: string }[]>([])
	const [isRunning, setIsRunning] = useState(false)
	const [activeOutputTab, setActiveOutputTab] = useState(() => {
		if (typeof window === 'undefined') {
			return 'transformed'
		}
		const savedTab = getStorageItem(activeOutputTabStorageKey)
		return savedTab || 'transformed'
	})
	const [compilerOptionsJson, setCompilerOptionsJson] = useState(compilerOptions)
	const [showCustomScriptManager, setShowCustomScriptManager] = useState(false)
	const [showCompilerOptions, setShowCompilerOptions] = useState(() => {
		if (typeof window === 'undefined') {
			return true
		}
		return getStorageItem(showCompilerOptionsStorageKey, 'true') !== 'false'
	})
	const [layoutVersion, setLayoutVersion] = useState(0)
	const [isJavaScript, setIsJavaScript] = useState(() => {
		if (typeof window === 'undefined') {
			return true
		}
		return getStorageItem(isJavaScriptStorageKey, 'true') !== 'false'
	})
	const [sourceFileName, setSourceFileName] = useState('input.js')
	const [transformedFileName, setTransformedFileName] = useState('transformed.js')
	const [compilerOptionsFileName, setCompilerOptionsFileName] = useState('compilerOptions.json')
	const runId = useRef(0)
	const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const sourceMountRafRef = useRef<number | null>(null)
	const isDirtyRef = useRef(false)
	const lastSavedCodeRef = useRef<string>('')
	//const diffModelRef = useRef<editor.IDiffEditorModel>(null);
	const sourceModelRef = useRef<editor.ITextModel>(null)
	const transformModelRef = useRef<editor.ITextModel>(null)
	const transformedModelRef = useRef<editor.ITextModel>(null)
	const compilerOptionsModelRef = useRef<editor.ITextModel>(null)
	const sourceEditorRef = useRef<editor.IStandaloneCodeEditor>(null)
	const sourcePaneRef = useRef<HTMLElement>(null)
	const transformEditorRef = useRef<editor.IStandaloneCodeEditor>(null)
	const transformPaneRef = useRef<HTMLElement>(null)
	const transformedEditorRef = useRef<editor.IStandaloneCodeEditor>(null)
	const transformedPaneRef = useRef<HTMLElement>(null)
	const compilerOptionsEditorRef = useRef<editor.IStandaloneCodeEditor>(null)
	const compilerOptionsPaneRef = useRef<HTMLElement>(null)
	const isJavaScriptRef = useRef(isJavaScript)
	const { setMarkers } = useMarkers()

	useEffect(() => { isJavaScriptRef.current = isJavaScript }, [isJavaScript])

	const layoutEditorInPane = (
		editorInstance: editor.IStandaloneCodeEditor | null,
		paneElement: HTMLElement | null,
	) => {
		if (!editorInstance || !paneElement) {
			return
		}

		const { width, height } = paneElement.getBoundingClientRect()
		if (width > 0 && height > 0) {
			editorInstance.layout({ width, height: Math.floor(height - 40) })
		}
	}

	const relayoutEditors = () => {
		layoutEditorInPane(sourceEditorRef.current, sourcePaneRef.current)
		layoutEditorInPane(transformEditorRef.current, transformPaneRef.current)
		layoutEditorInPane(compilerOptionsEditorRef.current, compilerOptionsPaneRef.current)
		layoutEditorInPane(transformedEditorRef.current, transformedPaneRef.current)
		window.dispatchEvent(new Event('resize'))
	}

	/** Builds the full VFS path for a transform file by name. */
	const toTransformPath = (fileName: string) => `${transformsDirPath}/${fileName}`

	/**
	 * Sanitizes a user-supplied transform file name: strips path components,
	 * ensures a `.ts` extension, and replaces unsafe characters with `_`.
	 */
	const normalizeTransformFileName = (name: string) => {
		const trimmed = name.trim().replace(/\\/g, '/').split('/').pop() ?? ''
		if (!trimmed)
			return ''
		const withExtension = trimmed.endsWith('.ts') ? trimmed : `${trimmed}.ts`
		return withExtension.replace(/[^A-Za-z0-9._-]/g, '_')
	}

	/** Persists the active transform file name to the VFS marker file. */
	const saveActiveTransformName = async (fileName: string) => {
		await fs.writeFile(activeTransformPath, fileName)
	}

	/**
	 * Writes transform code to both the named file in the transformers directory
	 * and the runtime transformer entry point.
	 */
	const writeTransformFile = async (fileName: string, code: string) => {
		if (!fileName)
			return
		await fs.writeFile(toTransformPath(fileName), code)
		await fs.writeFile(runtimeTransformPath, code)
	}

	/**
	 * Reads the transformers directory and returns the sorted list of `.ts`
	 * file names.
	 */
	const loadTransformFileList = async () => {
		const entries = await fs.readdir(transformsDirPath, true)
		return entries
			.filter(entry => !entry.dir && entry.name.endsWith('.ts'))
			.map(entry => entry.name)
			.sort((a, b) => a.localeCompare(b))
	}

	useEffect(() => {
		const initTransformFiles = async () => {
			try {
				let files = await loadTransformFileList()
				if (files.length === 0) {
					const defaultFile = 'transform1.ts'
					await fs.writeFile(toTransformPath(defaultFile), transformScript)
					files = [defaultFile]
				}

				let preferred = ''
				try {
					const savedLocal = getStorageItem(selectedTransformFileStorageKey)
					preferred = savedLocal || (await fs.readFile(activeTransformPath)).trim()
				} catch {
					preferred = getStorageItem(selectedTransformFileStorageKey)
				}

				const selected = files.includes(preferred) ? preferred : files[0]
				const initialCode = await fs.readFile(toTransformPath(selected!))

				setTransformFiles(files)
				setSelectedTransformFile(selected!)
				setTransform(initialCode || jsdoc)
				// Mark as saved since we just loaded from disk
				lastSavedCodeRef.current = initialCode || jsdoc
				isDirtyRef.current = false
				await saveActiveTransformName(selected!)
				setStorageItem(selectedTransformFileStorageKey, selected!)
			} catch (e: any) {
				setErrors([`Unable to load transform files: ${e}`])
			}
		}

		void initTransformFiles()
	}, [])

	// Scripts are only saved when "Run Transform" is clicked, not on auto-save

	/**
	 * Saves the current transform if dirty, loads the newly selected file,
	 * and updates all related state and persistent storage.
	 *
	 * @param nextFile - The file name to switch to.
	 */
	const handleSelectTransformFile = async (nextFile: string) => {
		if (!nextFile || nextFile === selectedTransformFile)
			return

		try {
			// Only save if we have a valid selectedTransformFile
			if (selectedTransformFile && transformCode.trim()) {
				await writeTransformFile(selectedTransformFile, transformCode)
			}
			const nextCode = await fs.readFile(toTransformPath(nextFile))
			setSelectedTransformFile(nextFile)
			setTransform(nextCode || jsdoc)
			// Mark as saved since we just loaded from disk
			lastSavedCodeRef.current = nextCode || jsdoc
			isDirtyRef.current = false
			await saveActiveTransformName(nextFile)
			setStorageItem(selectedTransformFileStorageKey, nextFile)
			await fs.writeFile(runtimeTransformPath, nextCode || jsdoc)
		} catch (e: any) {
			setErrors([`Unable to switch transform file: ${e}`])
		}
	}

	/**
	 * Prompts the user for a file name, creates a new transform file with the
	 * default template, and switches to it.
	 */
	const handleCreateTransformFile = async () => {
		const rawName = window.prompt('New transform file name', 'newTransform.ts')
		if (!rawName)
			return
		const fileName = normalizeTransformFileName(rawName)
		if (!fileName) {
			setErrors(['A valid transform file name is required'])
			return
		}
		if (transformFiles.includes(fileName)) {
			setErrors([`Transform file already exists: ${fileName}`])
			return
		}

		try {
			// Only save if dirty
			if (selectedTransformFile && transformCode.trim() && isDirtyRef.current) {
				await writeTransformFile(selectedTransformFile, transformCode)
			}
			await fs.writeFile(toTransformPath(fileName), jsdoc)
			const files = [...transformFiles, fileName].sort((a, b) => a.localeCompare(b))
			setTransformFiles(files)
			setSelectedTransformFile(fileName)
			setTransform(transformScript)
			// Mark as saved since we just created with template
			lastSavedCodeRef.current = transformScript
			isDirtyRef.current = false
			await saveActiveTransformName(fileName)
			setStorageItem(selectedTransformFileStorageKey, fileName)
			await fs.writeFile(runtimeTransformPath, transformScript)
		} catch (e: any) {
			setErrors([`Unable to create transform file: ${e}`])
		}
	}

	/**
	 * Confirms deletion of the selected transform file, removes it from the
	 * VFS, and switches to the next available file.
	 */
	const handleDeleteTransformFile = async () => {
		if (!selectedTransformFile)
			return
		if (transformFiles.length <= 1) {
			setErrors(['At least one transform file must remain'])
			return
		}
		if (!window.confirm(`Delete ${selectedTransformFile}?`))
			return

		try {
			await fs.rm(toTransformPath(selectedTransformFile))
			const remaining = transformFiles.filter(file => file !== selectedTransformFile)
			const nextFile = remaining[0]!
			const nextCode = await fs.readFile(toTransformPath(nextFile))
			setTransformFiles(remaining)
			setSelectedTransformFile(nextFile)
			setTransform(nextCode || jsdoc)
			// Mark as saved since we just loaded from disk
			lastSavedCodeRef.current = nextCode || jsdoc
			isDirtyRef.current = false
			await saveActiveTransformName(nextFile)
			setStorageItem(selectedTransformFileStorageKey, nextFile)
			await fs.writeFile(runtimeTransformPath, nextCode || jsdoc)
		} catch (e: any) {
			setErrors([`Unable to delete transform file: ${e}`])
		}
	}

	/**
	 * Re-reads the transformers directory and updates the file list, switching
	 * away from the selected file if it no longer exists.
	 */
	const handleRefreshTransformFiles = async () => {
		try {
			const files = await loadTransformFileList()
			setTransformFiles(files)
			if (!files.includes(selectedTransformFile) && files.length > 0) {
				const nextFile = files[0]!
				const nextCode = await fs.readFile(toTransformPath(nextFile))
				setSelectedTransformFile(nextFile)
				setTransform(nextCode || jsdoc)
				// Mark as saved since we just loaded from disk
				lastSavedCodeRef.current = nextCode || jsdoc
				isDirtyRef.current = false
				await saveActiveTransformName(nextFile)
				setStorageItem(selectedTransformFileStorageKey, nextFile)
				await fs.writeFile(runtimeTransformPath, nextCode || jsdoc)
			}
		} catch (e: any) {
			setErrors([`Unable to refresh transform files: ${e}`])
		}
	}

	useEffect(() => {
		setStorageItem(activeOutputTabStorageKey, activeOutputTab)
	}, [activeOutputTab])

	useEffect(() => {
		setStorageItem(showCompilerOptionsStorageKey, String(showCompilerOptions))
	}, [showCompilerOptions])

	useEffect(() => {
		setLayoutVersion((version) => version + 1)
		const timeoutId = window.setTimeout(() => {
			relayoutEditors()
			const rafId = window.requestAnimationFrame(() => {
				relayoutEditors()
				window.requestAnimationFrame(() => {
					relayoutEditors()
				})
			})

			return () => window.cancelAnimationFrame(rafId)
		}, 0)

		return () => window.clearTimeout(timeoutId)
	}, [showCompilerOptions])

	useEffect(() => {
		return () => {
			if (sourceMountRafRef.current !== null) {
				window.cancelAnimationFrame(sourceMountRafRef.current)
				sourceMountRafRef.current = null
			}
		}
	}, [])

	/**
	 * Saves the current file if dirty, then loads a custom script into the
	 * transform editor without associating it with a VFS file.
	 *
	 * @param customScript - The custom script to load.
	 */
	const handleLoadCustomScript = async (customScript: CustomScript) => {
		try {
			// Save current transform before loading custom script
			if (selectedTransformFile && transformCode.trim() && isDirtyRef.current) {
				await writeTransformFile(selectedTransformFile, transformCode)
			}
			// Load the custom script
			setTransform(customScript.code)
			// Clear selectedTransformFile to prevent overwriting files
			setSelectedTransformFile('')
			// Mark as saved since we just loaded the script
			lastSavedCodeRef.current = customScript.code
			isDirtyRef.current = false
			setErrors([])
		} catch (e: any) {
			setErrors([`Unable to load custom script: ${e}`])
		}
	}

	/**
	 * Executes the configured TypeScript transform against the current source,
	 * emits all outputs (transformed TS, JS, `.d.ts`, AST structure), and
	 * updates compiler options from the result.
	 */
	const handleRunTransform = async () => {
		//var source = diffModelRef.current!.original.getValue()
		setIsRunning(true)
		//diffModelRef.current?.original.setValue()
		const id = ++runId.current
		try {
			const ts = await getTsModule();
			let convertedOptions = convertCompilerOptions(compilerOptionsJson, ts);
			try {

				//await fs.writeFile(configPath, compilerOptionsJson);
			} catch (e) {
				setErrors([`Invalid compiler options JSON: ${e}`]);
				return;
			}
			// Convert string values to TypeScript enums		

			//parsedConfig.options
			var inputFileName = sourceModelRef.current!.getLanguageId() == "typescript" ? "input.ts" : "input.js"
			//var source = diffModelRef.current!.original.getValue();
			//var transformCode = transformModelRef.current!.getValue();
			if (selectedTransformFile) {
				await fs.writeFile(toTransformPath(selectedTransformFile), transformCode)
			}
			await fs.writeFile(runtimeTransformPath, transformCode)
			try {
				await fs.writeFile("./storage/source.ts", source)
			} catch (error) {
				console.warn('Unable to persist source.ts via vite-plugin-fs relay', error)
			}

			const result = await runTransform({
				inputFileName,
				source,
				transformerPath: runtimeTransformPath.replace(/^\./, ''),
				compilerOptions: convertedOptions
			})
			if (id === runId.current) {
				let newcompilerOptionsJson = JSON.stringify(convertCompilerOptions(result.compilerOptions, ts), null, "\t");
				await fs.writeFile(configPath, newcompilerOptionsJson);
				setTransformedTs(result.transformedTs)
				setEmittedJs(result.emittedJs)
				setDts(result.dts)
				setStructure(result.structure || '')
				const runtimeDebugLines = (result.debugLogs || []).map(line => `Debug: ${line}`)
				setErrors([
					...result.errors.map(e => `${e.message}: ${e.error}`),
					...runtimeDebugLines,
				])
				setPositions(result.errorPositions || [])
				setCompilerOptionsJson(newcompilerOptionsJson);
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

	/**
	 * Toggles the source and transformed-output editors between JavaScript and
	 * TypeScript mode by replacing their Monaco models.
	 *
	 * @param checked - `true` for JavaScript mode, `false` for TypeScript.
	 */
	const handleLanguageToggle = (checked: boolean) => {
		setIsJavaScript(checked)
		isJavaScriptRef.current = checked
		setStorageItem(isJavaScriptStorageKey, String(checked))

		const language = checked ? 'javascript' : 'typescript'
		const sourceEditorInstance = sourceEditorRef.current
		const sourceModelInstance = sourceModelRef.current
		//const transformedEditorInstance = transformedEditorRef.current
		//const transformedModelInstance = transformedModelRef.current

		if (!sourceEditorInstance || !sourceModelInstance
			//|| !transformedEditorInstance 
			//|| !transformedModelInstance
		) {
			return
		}

		try {
			sourceEditorInstance.getModel()
			//transformedEditorInstance.getModel()
			sourceModelInstance.getValue()
			//transformedModelInstance.getValue()
		} catch (ex) {
			console.error(ex);
			return
		}
		try {
			if (sourceModelInstance && sourceEditorInstance) {
				const sourceName = checked ? 'input.js' : 'input.ts'
				const sourceUriParsed = monaco.Uri.parse(checked ? 'file:///input.js' : 'file:///input.ts')
				const oldSourceModel = sourceModelInstance
				const newSourceModel = editor.getModel(sourceUriParsed)
					?? editor.createModel(oldSourceModel.getValue(), language, sourceUriParsed)
				sourceEditorInstance.setModel(newSourceModel)
				sourceModelRef.current = newSourceModel
				setSourceFileName(sourceName)
				if (oldSourceModel !== newSourceModel) oldSourceModel.dispose()
			}

			/*if (transformedModelInstance && transformedEditorInstance) {
				const transformedName = checked ? 'transformed.js' : 'transformed.ts'
				const transformedUriParsed = monaco.Uri.parse(checked ? 'file://dist/transformed.js' : 'file:///dist/transformed.ts')
				const oldTransformedModel = transformedModelInstance
				const newTransformedModel = editor.getModel(transformedUriParsed)
					?? editor.createModel(oldTransformedModel.getValue(), language, transformedUriParsed)
				transformedEditorInstance.setModel(newTransformedModel)
				transformedModelRef.current = newTransformedModel
				setTransformedFileName(transformedName)
				if (oldTransformedModel !== newTransformedModel) oldTransformedModel.dispose()
			}*/
		} catch (error) {
			console.warn('Skipping language toggle while Monaco is disposing', error)
		}
	}

	const outputFileName = activeOutputTab === 'transformed'
		? (isJavaScript ? 'transformed.js' : 'transformed.ts')
		: activeOutputTab === 'emitted'
			? 'emitted.js'
			: activeOutputTab === 'dts'
				? 'emitted.d.ts'
				: 'structure.ts'



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
					disabled={isRunning || (!selectedTransformFile && transformCode.trim() === jsdoc.trim())}
					style={{
						padding: '0.5rem 1rem',
						fontSize: '1rem',
						cursor: (isRunning || (!selectedTransformFile && transformCode.trim() === jsdoc.trim())) ? 'not-allowed' : 'pointer',
						opacity: (isRunning || (!selectedTransformFile && transformCode.trim() === jsdoc.trim())) ? 0.6 : 1
					}}
					title={!selectedTransformFile ? 'Using custom script' : ''}
				>
					{isRunning ? 'Running...' : 'Run Transform'}
				</button>
				<div className='transform-file-controls'>
					<label htmlFor='transformFileSelect'>Transform File</label>
					<select
						id='transformFileSelect'
						value={selectedTransformFile}
						onChange={(event) => {
							void handleSelectTransformFile(event.currentTarget.value)
						}}
					>
						{transformFiles.map(file => (
							<option key={file} value={file}>{file}</option>
						))}
					</select>
					<button type='button' onClick={() => void handleCreateTransformFile()}>New</button>
					<button type='button' onClick={() => void handleDeleteTransformFile()} disabled={transformFiles.length <= 1}>Delete</button>
					<button type='button' onClick={() => void handleRefreshTransformFiles()}>Refresh</button>
					<button type='button' onClick={() => setShowCustomScriptManager(true)}>Custom Scripts</button>
					<button type='button' onClick={() => setShowCompilerOptions((current) => !current)}>
						{showCompilerOptions ? 'Hide Compiler Options' : 'Show Compiler Options'}
					</button>
				</div>
				<label htmlFor='language'>Javascript? </label>
				<input
					type='checkbox'
					onChange={(event) => handleLanguageToggle(event.currentTarget.checked)}
					checked={isJavaScript}
					title='Javascript?:'
					name='language'
				></input>
			</div>

			<main key={layoutVersion} className="grid" style={{ gridTemplateColumns: showCompilerOptions ? '1fr 1fr 1fr' : '1fr 1fr' }}>
				<section className="pane" ref={sourcePaneRef}>
					<h2>Source ({sourceFileName})</h2>

					<Editor height="100%" theme="vs-dark" defaultLanguage="javascript"
						value={source}
						defaultPath='file:///input.js'
						onChange={(v) => setSource(v ?? '')}
						onMount={(editorInstance) => {
							sourceEditorRef.current = editorInstance;
							sourceModelRef.current = editorInstance.getModel();
							if (sourceMountRafRef.current !== null) {
								window.cancelAnimationFrame(sourceMountRafRef.current)
							}
							sourceMountRafRef.current = window.requestAnimationFrame(() => {
								sourceMountRafRef.current = null
								handleLanguageToggle(isJavaScriptRef.current);
							})
						}}
						options={
							{
								fontSize: 14,
								minimap: { enabled: false },
								automaticLayout: true,
							}} />
				</section>
				<section className="pane" ref={transformPaneRef}>
					<h2>Transform (transform.ts)</h2>
					<Editor height="100%" theme="vs-dark" defaultLanguage="typescript"
						defaultPath='file:///transform.ts'
						value={transformCode}
						onChange={(v) => {
							const newValue = v ?? '';
							isDirtyRef.current = true
							setTransform(newValue.length > 0 ? newValue : jsdoc);
						}}
						onMount={(editor) => {
							transformEditorRef.current = editor
							transformModelRef.current = editor.getModel()
						}}
						options={{
							fontSize: 14,
							minimap: { enabled: false },
							automaticLayout: true,
						}}
					/>
				</section>

				{showCompilerOptions && (
					<section className="pane" ref={compilerOptionsPaneRef}>
						<h2>Compiler Options ({compilerOptionsFileName})</h2>
						<Editor height="100%" theme="vs-dark" defaultLanguage="json"
							defaultPath='file://compilerOptions.json'
							value={compilerOptionsJson}
							onChange={(v) => setCompilerOptionsJson(v ?? '')}
							onMount={(editor) => {
								compilerOptionsEditorRef.current = editor;
								const model = editor.getModel();
								compilerOptionsModelRef.current = model;
								if (model) {
									setCompilerOptionsFileName(model.uri.path.split('/').pop() ?? 'compilerOptions.json');
								}
							}}
							options={{
								fontSize: 14,
								minimap: { enabled: false },
								automaticLayout: true,
							}}
						/>
					</section>
				)}

				<section className="pane output" style={{ gridColumn: showCompilerOptions ? 'span 3' : 'span 2' }} ref={transformedPaneRef}>
					<h2>Outputs ({outputFileName})</h2>
					<div className="tabs">
						<button onClick={() => setActiveOutputTab('transformed')} className={activeOutputTab === 'transformed' ? 'active' : ''}>Transformed (.ts)</button>
						<button onClick={() => setActiveOutputTab('emitted')} className={activeOutputTab === 'emitted' ? 'active' : ''}>Emitted (.js)</button>
						<button onClick={() => setActiveOutputTab('dts')} className={activeOutputTab === 'dts' ? 'active' : ''}>Definition (.d.ts)</button>
						<button onClick={() => setActiveOutputTab('structure')} className={activeOutputTab === 'structure' ? 'active' : ''}>Structure (AST)</button>
					</div>
					{activeOutputTab === 'transformed' && <Editor height="100%" theme="vs-dark" language={isJavaScript ? 'javascript' : 'typescript'}
						value={transformedTs}
						path={isJavaScript ? 'file:///dist/transformed.js' : 'file:///dist/transformed.ts'}
						onMount={(editorInstance) => {
							/*transformedEditorRef.current = editorInstance;
							transformedModelRef.current = editorInstance.getModel();
							setTransformedFileName(isJavaScriptRef.current ? 'transformed.js' : 'transformed.ts');
							handleLanguageToggle(isJavaScriptRef.current);*/
						}}
						options={{ fontSize: 14, readOnly: true, minimap: { enabled: false }, automaticLayout: true }} />}
					{activeOutputTab === 'emitted' && <Editor height="100%" theme="vs-dark" defaultLanguage="javascript"
						defaultPath='file:///emitted.js'
						value={emittedJs}
						options={{ fontSize: 14, readOnly: true, minimap: { enabled: false }, automaticLayout: true }} />}
					{activeOutputTab === 'dts' && <Editor height="100%" theme="vs-dark" defaultLanguage="typescript"
						defaultPath='file:///emitted.d.ts'
						value={dts}
						options={{ fontSize: 14, readOnly: true, minimap: { enabled: false }, automaticLayout: true }} />}
					{activeOutputTab === 'structure' && <Editor height="100%" theme="vs-dark" defaultLanguage="typescript"
						defaultPath='file:///structure.ts'
						value={structure}
						options={{ fontSize: 14, readOnly: false, minimap: { enabled: false }, automaticLayout: true, "tabSize": 4 }} />}
				</section>
			</main>

			{errors.length > 0 && (
				<div className="error-popup-overlay" onClick={() => setErrors([])}>
					<div className="error-popup" onClick={(e) => e.stopPropagation()}>
						<div className="error-popup-header">
							<strong>Errors</strong>
							<button className="error-popup-close" onClick={() => setErrors([])} aria-label="Close errors">&times;</button>
						</div>
						<ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
					</div>
				</div>
			)}

			{showCustomScriptManager && (
				<CustomScriptManager
					onLoadScript={handleLoadCustomScript}
					onClose={() => setShowCustomScriptManager(false)}
				/>
			)}
		</div>
	)
}
