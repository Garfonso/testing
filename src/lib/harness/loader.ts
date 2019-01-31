import { isObject } from "alcalzone-shared/typeguards";
import Module from "module";
import * as path from "path";

export function createMockRequire(originalRequire: NodeRequire, mocks: Record<string, any>, relativeToFile?: string) {
	let relativeToDir: string | undefined;
	if (relativeToFile != undefined) {
		relativeToDir = path.dirname(relativeToFile);
	}
	return function fakeRequire(filename: string) {
		// Resolve relative paths relative to the require-ing module
		if (relativeToDir != undefined && filename.startsWith(".")) {
			filename = path.join(relativeToDir, filename);
		}
		if (filename in mocks) return mocks[filename].exports;
		return originalRequire(filename);
	};
}

/**
 * Builds a proxy around a global object with the given properties or methods
 * proxied to their given replacements
 */
function buildProxy(global: any, mocks: Record<string, any>) {
	return new Proxy(global, {
		get: (target, name) => {
			if (name in mocks) return mocks[name as any];
			return target[name];
		},
	});
}

/**
 * Monkey-patches module code before executing it by wrapping it in an IIFE whose arguments are modified (proxied) globals
 * @param code The code to monkey patch
 * @param globals A dictionary of globals and their properties to be replaced
 */
export function monkeyPatchGlobals(code: string, globals: Record<string, Record<string, any>>) {
	const prefix: string = `"use strict";
${buildProxy}

((${Object.keys(globals).join(", ")}) => {`;
	const patchedArguments = Object.keys(globals)
		.map(glob => {
			const patchObj = globals[glob];
			const patches = Object.keys(patchObj).map(fn => `${fn}: ${patchObj[fn]}`);
			return `buildProxy(${glob}, {${patches.join(", ")}})`;
		});
	const postfix: string = `
})(${patchedArguments.join(", ")});`;
	return prefix + code + postfix;
}

/** A test-safe replacement for process.exit that throws a specific error instead */
export function fakeProcessExit(code: number = 0) {
	const err = new Error(`process.exit was called with code ${code}`);
	// @ts-ignore
	err.processExitCode = code;
	throw err;
}

/**
 * Replaces NodeJS's default loader for .js-files with the given one and returns the original one
 */
export function replaceJsLoader(loaderFunction: NodeExtensions[string]): NodeExtensions[string] {
	const originalJsLoader = require.extensions[".js"];
	require.extensions[".js"] = loaderFunction;
	return originalJsLoader;
}

/**
 * Replaces a replaced loader for .js-files with the original one
 */
export function restoreJsLoader(originalJsLoader: NodeExtensions[string]) {
	require.extensions[".js"] = originalJsLoader;
}

export interface HarnessOptions {
	/** Mocks for loaded modules */
	mockedModules?: Record<string, Module>;
	/** Whether the main module should believe that it was not required */
	fakeNotRequired?: boolean;
	/** Patches for global objects like `process` */
	globalPatches?: Record<string, Record<string, any>>;
}

/**
 * Loads the given module into the test harness and returns the module's `module.exports`.
 */
export function loadModuleInHarness(moduleFilename: string, options: HarnessOptions = {}) {
	let originalJsLoader: NodeExtensions[string];
	originalJsLoader = replaceJsLoader((module: any, filename: string) => {
		// If we want to replace some modules with mocks, we need to change the module's require function
		if (isObject(options.mockedModules)) {
			module.require = createMockRequire(module.require.bind(module), options.mockedModules, filename);
		}
		if (options.fakeNotRequired && path.normalize(filename) === path.normalize(moduleFilename)) {
			module.parent = null;
		}
		// If necessary, edit the source code before executing it
		if (isObject(options.globalPatches)) {
			const originalCompile = module._compile;
			module._compile = (code: string, _filename: string) => {
				code = monkeyPatchGlobals(code, options.globalPatches!);

				// Restore everything to not break the NodeJS internals
				module._compile = originalCompile;
				module._compile(code, _filename);
			};
		}
		// Call the original loader
		originalJsLoader(module, filename);
	});

	// Make sure the main file is not already loaded into the require cache
	if (moduleFilename in require.cache) delete require.cache[moduleFilename];
	// And load the module
	const moduleExport: unknown = require(moduleFilename);

	// Restore the js loader so we don't fuck up more things
	restoreJsLoader(originalJsLoader!);

	return moduleExport;
}
