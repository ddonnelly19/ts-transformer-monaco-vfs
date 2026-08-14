import { useEffect, useState } from 'react';
import {
	getAllCustomScripts,
	loadCustomScript,
	deleteCustomScript,
	downloadCustomScript,
	importCustomScript,
	saveCustomScript,
	generateScriptId,
	type CustomScript
} from '../transformScriptManager';

/** Props for the {@link CustomScriptManager} modal component. */
interface CustomScriptManagerProps {
	/** Called when the user clicks "Load Selected Script" with the resolved script. */
	onLoadScript: (script: CustomScript) => void;
	/** Called when the modal should be dismissed. */
	onClose: () => void;
}

/**
 * Modal dialog for managing custom transform scripts stored in `localStorage`.
 *
 * Features:
 * - Browse, search, and preview saved scripts.
 * - Import scripts from a `.json` file or pasted JSON text.
 * - Export (download) individual scripts as JSON.
 * - Delete scripts with confirmation.
 * - Load a selected script into the parent editor.
 *
 * @param onLoadScript - Callback invoked with the chosen {@link CustomScript} when
 *   the user confirms loading.
 * @param onClose - Callback to close/unmount this modal.
 */
export function CustomScriptManager({ onLoadScript, onClose }: CustomScriptManagerProps) {
	const [scripts, setScripts] = useState<CustomScript[]>([]);
	const [selectedId, setSelectedId] = useState<string>('');
	const [showImportDialog, setShowImportDialog] = useState(false);
	const [showCreateDialog, setShowCreateDialog] = useState(false);
	const [newScriptName, setNewScriptName] = useState('');
	const [importError, setImportError] = useState('');
	const [filterQuery, setFilterQuery] = useState('');

	useEffect(() => {
		refreshScripts();
	}, []);

	/** Reloads the script list from `localStorage` and selects the first item if none is selected. */
	const refreshScripts = () => {
		const allScripts = getAllCustomScripts();
		setScripts(allScripts);
		if (allScripts.length > 0 && !selectedId) {
			setSelectedId(allScripts[0].id);
		}
	};

	/** Loads the currently-selected script into the parent editor and closes the modal. */
	const handleLoadScript = () => {
		if (!selectedId) return;
		const script = loadCustomScript(selectedId);
		if (script) {
			onLoadScript(script);
			onClose();
		}
	};

	/**
	 * Prompts the user to confirm deletion, then removes the script from
	 * `localStorage` and refreshes the list.
	 * @param id - The ID of the script to delete.
	 */
	const handleDeleteScript = (id: string) => {
		if (!window.confirm('Delete this custom script?')) return;
		deleteCustomScript(id);
		refreshScripts();
		if (selectedId === id) {
			setSelectedId(scripts.find(s => s.id !== id)?.id || '');
		}
	};

	/**
	 * Triggers a browser file download for the script as a `.json` file.
	 * @param id - The ID of the script to export.
	 */
	const handleExportScript = (id: string) => {
		const script = loadCustomScript(id);
		if (script) {
			downloadCustomScript(script);
		}
	};

	/**
	 * Handles file-picker import: reads the selected `.json` file, parses it as
	 * a {@link CustomScript}, saves it to `localStorage`, and selects it.
	 * @param event - The `change` event from the hidden file input.
	 */
	const handleImportFromFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0];
		if (!file) return;

		try {
			const content = await file.text();
			const imported = importCustomScript(content);
			setImportError('');
			setShowImportDialog(false);
			refreshScripts();
			setSelectedId(imported.id);
		} catch (error) {
			setImportError(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	};

	/**
	 * Prompts the user to paste raw JSON, parses it as a {@link CustomScript},
	 * saves it to `localStorage`, and selects it.
	 */
	const handleImportRawJSON = () => {
		const json = window.prompt('Paste custom script JSON:');
		if (!json) return;

		try {
			const imported = importCustomScript(json);
			setImportError('');
			setShowImportDialog(false);
			refreshScripts();
			setSelectedId(imported.id);
		} catch (error) {
			setImportError(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	};

	const filtered = scripts.filter(s =>
		s.name.toLowerCase().includes(filterQuery.toLowerCase()) ||
		s.description.toLowerCase().includes(filterQuery.toLowerCase())
	);

	return (
		<div className="custom-script-manager-modal">
			<div className="modal-backdrop" onClick={onClose} />
			<div className="modal-content">
				<div className="modal-header">
					<h2>Custom Transform Scripts</h2>
					<button className="close-btn" onClick={onClose}>✕</button>
				</div>

				<div className="modal-body">
					<div className="scripts-list-section">
						<div className="controls">
							<input
								type="text"
								placeholder="Search scripts..."
								value={filterQuery}
								onChange={(e) => setFilterQuery(e.currentTarget.value)}
								className="search-input"
							/>
							<button onClick={() => setShowImportDialog(true)}>Import</button>
							<button onClick={() => setShowCreateDialog(true)}>New</button>
						</div>

						{showImportDialog && (
							<div className="import-dialog">
								<div className="dialog-content">
									<h3>Import Custom Script</h3>
									{importError && <div className="error-message">{importError}</div>}
									<div className="import-options">
										<label className="file-input-label">
											<input
												type="file"
												accept=".json"
												onChange={handleImportFromFile}
												style={{ display: 'none' }}
											/>
											<span>📁 Choose File</span>
										</label>
										<button onClick={handleImportRawJSON}>📋 Paste JSON</button>
									</div>
									<button
										className="cancel-btn"
										onClick={() => {
											setShowImportDialog(false);
											setImportError('');
										}}
										type="reset"
									>
										Cancel
									</button>
								</div>
							</div>
						)}

						{showCreateDialog && (
							<div className="create-dialog">
								<div className="dialog-content">
									<h3>Save Current Transform as Custom Script</h3>
									<input
										type="text"
										placeholder="Script name"
										value={newScriptName}
										onChange={(e) => setNewScriptName(e.currentTarget.value)}
										className="name-input"
									/>
									<div className="dialog-actions">
										<button
											onClick={() => {
												if (newScriptName.trim()) {
													const code = window.prompt('Enter transform code:') || '';
													if (code) {
														saveCustomScript(
															generateScriptId(),
															newScriptName,
															code,
															''
														);
														setNewScriptName('');
														setShowCreateDialog(false);
														refreshScripts();
													}
												}
											}}
										>
											Save
										</button>
										<button
											className="cancel-btn"
											onClick={() => {
												setNewScriptName('');
												setShowCreateDialog(false);
											}}
										>
											Cancel
										</button>
									</div>
								</div>
							</div>
						)}

						<ul className="scripts-list">
							{filtered.map(script => (
								<li
									key={script.id}
									className={`script-item ${selectedId === script.id ? 'selected' : ''}`}
									onClick={() => setSelectedId(script.id)}
								>
									<div className="script-info">
										<div className="script-name">{script.name}</div>
										{script.description && (
											<div className="script-description">{script.description}</div>
										)}
										<div className="script-meta">
											Updated: {new Date(script.updatedAt).toLocaleDateString()}
										</div>
									</div>
									<div className="script-actions">
										<button
											title="Export"
											onClick={(e) => {
												e.stopPropagation();
												handleExportScript(script.id);
											}}
										>
											⬇️
										</button>
										<button
											title="Delete"
											onClick={(e) => {
												e.stopPropagation();
												handleDeleteScript(script.id);
											}}
										>
											🗑️
										</button>
									</div>
								</li>
							))}
						</ul>

						{filtered.length === 0 && (
							<div style={{ padding: '2rem', textAlign: 'center', color: '#999' }}>
								{scripts.length === 0
									? 'No custom scripts yet. Create or import one!'
									: 'No scripts match your search.'}
							</div>
						)}
					</div>

					{selectedId && (
						<div className="script-preview-section">
							<div className="preview-header">
								<h3>Preview</h3>
							</div>
							<pre className="script-preview">
								{loadCustomScript(selectedId)?.code || ''}
							</pre>
						</div>
					)}
				</div>

				<div className="modal-footer">
					<button
						onClick={handleLoadScript}
						disabled={!selectedId}
						className="load-btn"
					>
						Load Selected Script
					</button>
					<button onClick={onClose} className="cancel-btn">
						Close
					</button>
				</div>
			</div>
		</div>
	);
}
