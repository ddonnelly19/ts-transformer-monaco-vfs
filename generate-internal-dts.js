#!/usr/bin / env node
/**
 * Generates a single `typescript-internal.d.ts` including @internal members
 * from the latest TypeScript source, with Windows long-path safe handling.
 */

import { execSync } from "child_process";
import { writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { relative, join, resolve } from "path";

/**
 * @param {string} cmd
 */
function run(cmd, opts = {}) {
	try {
		console.log(`\n> ${cmd}`);
		execSync(cmd, {
			stdio: "inherit",
			...opts
		});
	} catch (ex) {
		console.error(ex);
	}
}

/**
 * @param {import("node:fs").PathLike} dir
 */
function ensureDir(dir) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function main() {
	// Use a short, deterministic working dir inside the workspace
	const dtsName = "typescript.internal.d.ts";
	const cwd = process.cwd();
	const workRoot = join(cwd, ".ts-build"); // short path like C:\repo\.ts-build
	ensureDir(workRoot);

	const repoDir = join(workRoot, "TS"); // keep it short: "TS"
	const outSingle = resolve(cwd, dtsName);

	console.log(`Working directory: ${workRoot}`);

	// 1) Clone TypeScript with options that reduce path depth
	// - Use depth=1 and sparse filter to minimize checkout size/paths
	
	//if (!existsSync(join(repoDir, ".git")))
	
	run(`git clone  -c core.longpaths=true --depth 1 https://github.com/microsoft/TypeScript.git "${repoDir}"`);
	//run(`git config core.longpaths true`, { cwd: repoDir });
	// Enable long paths in this local repo (helps if system setting isn't applied)


	// Optional: sparse checkout to limit to src and build essentials
	// (TypeScript uses a standard structure; this reduces path breadth)
	try {
		run(`git sparse-checkout init --cone`, { cwd: repoDir });
		run(`git sparse-checkout set src scripts`, { cwd: repoDir });
	} catch {
		// Sparse checkout not available in older Git; ignore
	}

	// 2) Install dependencies
	run(`npm install`, { cwd: repoDir });
	//const srcDir = join(repoDir, "src");
	// 4) Emit declarations (only .d.ts files)
	run(`npx hereby dts`, { cwd: repoDir });

	const bundledPath = join(repoDir, "built//local", dtsName);

	// 6) Copy artifact to workspace root
	copyFileSync(bundledPath, outSingle);
	console.log(`\n✅ Generated single file at: ${outSingle}\n`);
	rmSync(repoDir, {"force": true, recursive: true})
}

main();