import ts from "typescript";
import { printNode } from "ts-morph";

/* ============================================================================
 * Generic enum and bitfield utilities
 * ========================================================================== */

/**
 * Extracts the names of properties whose values are numeric.
 *
 * This works with TypeScript numeric enums and ordinary enum-like objects.
 */
export type NumericEnumName<TEnum extends object> = {
	[TKey in keyof TEnum]:
		TKey extends string
			? TEnum[TKey] extends number
				? TKey
				: never
			: never;
}[keyof TEnum];

/**
 * Represents a forward numeric enum entry.
 */
export type NumericEnumEntry<TEnum extends object> = readonly [
	name: NumericEnumName<TEnum>,
	value: number,
];

/**
 * Metadata describing a numeric flag value.
 */
export interface SerializedFlags<TName extends string = string> {
	/**
	 * Original numeric value.
	 */
	raw: number;

	/**
	 * Atomic, single-bit flag names present in the value.
	 */
	names: TName[];

	/**
	 * Enum members whose numeric value exactly matches the complete value.
	 *
	 * This can include aliases or composite enum members.
	 */
	exactNames?: TName[];

	/**
	 * Bits that could not be matched to atomic enum members.
	 */
	unknownBits?: number;
}

/**
 * Tests whether every bit in `mask` is present in `value`.
 */
export function hasFlags(value: number, mask: number): boolean {
	return mask !== 0 && (value & mask) === mask;
}

/**
 * Tests whether at least one bit in `mask` is present in `value`.
 */
export function hasAnyFlag(value: number, mask: number): boolean {
	return mask !== 0 && (value & mask) !== 0;
}

/**
 * Tests whether `value` contains exactly one set bit.
 */
export function isSingleBit(value: number): boolean {
	return value > 0 && (value & (value - 1)) === 0;
}

/**
 * Returns only the forward numeric entries from a numeric enum-like object.
 *
 * Numeric TypeScript enums contain reverse mappings such as:
 *
 *     1: "SomeFlag"
 *
 * Those reverse mappings have string values and are intentionally excluded.
 */
export function getNumericEnumEntries<const TEnum extends object>(
	enumObject: TEnum,
): NumericEnumEntry<TEnum>[] {
	const entries: NumericEnumEntry<TEnum>[] = [];

	for (const [key, value] of Object.entries(
		enumObject as Record<string, unknown>,
	)) {
		if (typeof value !== "number") {
			continue;
		}

		entries.push([
			key as NumericEnumName<TEnum>,
			value,
		]);
	}

	return entries;
}

/**
 * Returns all enum names whose numeric value exactly equals `value`.
 *
 * Multiple names can be returned when an enum contains aliases.
 */
export function getExactEnumNames<const TEnum extends object>(
	value: number,
	enumObject: TEnum,
): NumericEnumName<TEnum>[] {
	return getNumericEnumEntries(enumObject)
		.filter(([, enumValue]) => enumValue === value)
		.map(([name]) => name)
		.sort();
}

/**
 * Returns the first enum name whose numeric value exactly equals `value`.
 */
export function getExactEnumName<const TEnum extends object>(
	value: number,
	enumObject: TEnum,
): NumericEnumName<TEnum> | undefined {
	return getExactEnumNames(value, enumObject)[0];
}

/**
 * Returns the atomic flag names present in `value`.
 *
 * Composite enum members are intentionally excluded. Use
 * `getExactEnumNames` when exact aliases or composite names are needed.
 *
 * If multiple names represent the same numeric bit, the lexically first
 * alias is selected to keep output deterministic.
 */
export function getFlagNames<const TEnum extends object>(
	value: number,
	enumObject: TEnum,
	...excludeValues: number[]
): NumericEnumName<TEnum>[] {
	const namesByValue = new Map<
		number,
		NumericEnumName<TEnum>[]
	>();

	for (const [name, enumValue] of getNumericEnumEntries(enumObject)) {
		if (
			excludeValues.includes(enumValue) ||
			!isSingleBit(enumValue) ||
			!hasFlags(value, enumValue)
		) {
			continue;
		}

		const aliases = namesByValue.get(enumValue);

		if (aliases) {
			aliases.push(name);
		} else {
			namesByValue.set(enumValue, [name]);
		}
	}

	return Array.from(namesByValue.entries())
		.sort(([leftValue], [rightValue]) => leftValue - rightValue)
		.map(([, aliases]) => aliases.sort()[0]);
}

/**
 * Serializes a numeric bitfield into stable diagnostic metadata.
 *
 * Atomic flag names are kept separate from enum members that exactly match
 * the complete numeric value. This prevents composite masks from being
 * presented as though they were independent bits.
 */
export function serializeFlags<const TEnum extends object>(
	value: number,
	enumObject: TEnum,
	...excludeValues: number[]
): SerializedFlags<NumericEnumName<TEnum>> {
	const entries = getNumericEnumEntries(enumObject);

	const namesByValue = new Map<
		number,
		NumericEnumName<TEnum>[]
	>();

	for (const [name, enumValue] of entries) {
		if (
			excludeValues.includes(enumValue) ||
			!isSingleBit(enumValue) ||
			!hasFlags(value, enumValue)
		) {
			continue;
		}

		const aliases = namesByValue.get(enumValue);

		if (aliases) {
			aliases.push(name);
		} else {
			namesByValue.set(enumValue, [name]);
		}
	}

	const names = Array.from(namesByValue.entries())
		.sort(([leftValue], [rightValue]) => leftValue - rightValue)
		.map(([, aliases]) => aliases.sort()[0]);

	const knownBits = Array.from(namesByValue.keys()).reduce(
		(result, flag) => result | flag,
		0,
	);

	const exactNames = entries
		.filter(
			([, enumValue]) =>
				enumValue === value &&
				!excludeValues.includes(enumValue),
		)
		.map(([name]) => name)
		.sort();

	const unknownBits = value & ~knownBits;

	return {
		raw: value,
		names,
		exactNames:
			exactNames.length > 0
				? exactNames
				: undefined,
		unknownBits:
			unknownBits !== 0
				? unknownBits
				: undefined,
	};
}

/* ============================================================================
 * Serialized compiler graph types
 * ========================================================================== */

/**
 * A reference to an object already serialized elsewhere in the graph.
 */
export interface SerializedReference {
	$ref: number;
}

/**
 * Base shape for serialized compiler objects.
 */
export interface SerializedObject {
	$id: number;
	$type: string;
}

/**
 * Serialized representation of a TypeScript node.
 */
export interface SerializedNode extends SerializedObject {
	$type: "Node";

	kind: {
		raw: number;
		name?: NumericEnumName<typeof ts.SyntaxKind>;
	};

	flags: SerializedFlags<
		NumericEnumName<typeof ts.NodeFlags>
	>;

	fileName?: string;
	pos: number;
	end: number;
	text?: string;
}

/**
 * Serialized representation of a TypeScript type.
 */
export interface SerializedType extends SerializedObject {
	$type: "Type";

	flags: SerializedFlags<
		NumericEnumName<typeof ts.TypeFlags>
	>;

	objectFlags?: SerializedFlags<
		NumericEnumName<typeof ts.ObjectFlags>
	>;

	display?: string;
	intrinsicName?: string;

	symbol?: SerializedValue;
	aliasSymbol?: SerializedValue;
	aliasTypeArguments?: SerializedValue;
	typeArguments?: SerializedValue;
	baseTypes?: SerializedValue;
	constraint?: SerializedValue;
	defaultType?: SerializedValue;
}

/**
 * Serialized representation of a TypeScript symbol.
 */
export interface SerializedSymbol extends SerializedObject {
	$type: "Symbol";

	name: string;
	escapedName: string;

	flags: SerializedFlags<
		NumericEnumName<typeof ts.SymbolFlags>
	>;

	type?: SerializedValue;
	declaredType?: SerializedValue;

	members?: SerializedValue;
	exports?: SerializedValue;
	globalExports?: SerializedValue;

	exportSymbol?: SerializedValue;
	declarations?: SerializedValue;
	valueDeclaration?: SerializedValue;

	isReferenced?: SerializedFlags<
		NumericEnumName<typeof ts.SymbolFlags>
	>;

	parent?: SerializedValue;
}

/**
 * Serialized representation of a Map.
 */
export interface SerializedMap extends SerializedObject {
	$type: "Map";

	entries: Array<{
		key: SerializedValue;
		value: SerializedValue;
	}>;
}

/**
 * Serialized representation of a Set.
 */
export interface SerializedSet extends SerializedObject {
	$type: "Set";
	values: SerializedValue[];
}

/**
 * Serialized representation of an array.
 */
export interface SerializedArray extends SerializedObject {
	$type: "Array";
	values: SerializedValue[];
}

/**
 * Serialized representation of an otherwise unrecognized object.
 */
export interface SerializedPlainObject extends SerializedObject {
	$type: "Object";
	constructorName?: string;
	properties: Record<string, SerializedValue>;
}

/**
 * Serialized error information.
 */
export interface SerializedError {
	$type: "SerializationError";
	message: string;
	name?: string;
	stack?: string;
	context?: string;
}

/**
 * All values that can appear in the normalized output graph.
 */
export type SerializedValue =
	| null
	| undefined
	| string
	| number
	| boolean
	| bigint
	| SerializedReference
	| SerializedNode
	| SerializedType
	| SerializedSymbol
	| SerializedMap
	| SerializedSet
	| SerializedArray
	| SerializedPlainObject
	| SerializedError;

/* ============================================================================
 * Serializer options and internal compiler types
 * ========================================================================== */

/**
 * Options controlling compiler-object serialization.
 */
export interface SymbolSerializerOptions {
	/**
	 * Includes printed source text for serialized nodes.
	 *
	 * Printing every node can significantly increase output size and runtime.
	 *
	 * @default true
	 */
	includeNodeText?: boolean;

	/**
	 * Includes the value-side type returned by `getTypeOfSymbol`.
	 *
	 * @default true
	 */
	includeSymbolType?: boolean;

	/**
	 * Includes the declared type returned by `getDeclaredTypeOfSymbol`.
	 *
	 * @default true
	 */
	includeDeclaredType?: boolean;

	/**
	 * Includes symbol declarations.
	 *
	 * @default true
	 */
	includeDeclarations?: boolean;

	/**
	 * Includes symbol members, exports, and global exports.
	 *
	 * @default true
	 */
	includeSymbolTables?: boolean;

	/**
	 * Includes the parent of each root symbol.
	 *
	 * Nested symbols omit their parent to avoid unnecessarily expanding the
	 * complete symbol hierarchy.
	 *
	 * @default false
	 */
	includeRootSymbolParent?: boolean;

	/**
	 * Includes enumerable properties from otherwise unrecognized objects.
	 *
	 * Compiler nodes, symbols, and types always use explicit projections.
	 *
	 * @default true
	 */
	includePlainObjects?: boolean;

	/**
	 * Maximum recursive traversal depth.
	 *
	 * @default 25
	 */
	maxDepth?: number;

	/**
	 * Number of spaces or indentation string used by `JSON.stringify`.
	 *
	 * @default "\t"
	 */
	indent?: string | number;
}

interface ResolvedSymbolSerializerOptions {
	includeNodeText: boolean;
	includeSymbolType: boolean;
	includeDeclaredType: boolean;
	includeDeclarations: boolean;
	includeSymbolTables: boolean;
	includeRootSymbolParent: boolean;
	includePlainObjects: boolean;
	maxDepth: number;
	indent: string | number;
}

/**
 * Internal SourceFile properties used for compiler diagnostics.
 *
 * `locals` and `symbol` are compiler implementation details rather than
 * stable public TypeScript API members.
 */
interface InternalSourceFile extends Omit<ts.SourceFile, "symbol" | "locals"> {
	locals?: ReadonlyMap<ts.__String, ts.Symbol>;
	symbol?: ts.Symbol;
}

/**
 * Internal Type properties used by the explicit serializer.
 */
interface InternalType extends Omit<ts.Type, "symbol"> {
	intrinsicName?: string;

	symbol?: ts.Symbol;
	aliasSymbol?: ts.Symbol;

	aliasTypeArguments?: readonly ts.Type[];
	typeArguments?: readonly ts.Type[];
	baseTypes?: readonly ts.BaseType[];

	constraint?: ts.Type;
	default?: ts.Type;

	objectFlags?: ts.ObjectFlags;
}

/**
 * Internal Symbol properties used by the explicit serializer.
 */
interface InternalSymbol extends ts.Symbol {
	parent?: ts.Symbol;
	globalExports?: ts.SymbolTable;
	exportSymbol?: ts.Symbol;
	isReferenced?: number;
}

const DEFAULT_OPTIONS: ResolvedSymbolSerializerOptions = {
	includeNodeText: true,
	includeSymbolType: true,
	includeDeclaredType: true,
	includeDeclarations: true,
	includeSymbolTables: true,
	includeRootSymbolParent: false,
	includePlainObjects: true,
	maxDepth: 25,
	indent: "\t",
};

/* ============================================================================
 * Compiler object type guards
 * ========================================================================== */

/**
 * Safely obtains an object's runtime constructor name.
 */
function getConstructorName(value: object): string | undefined {
	const constructor = (
		value as {
			constructor?: {
				name?: unknown;
			};
		}
	).constructor;

	return typeof constructor?.name === "string"
		? constructor.name
		: undefined;
}

/**
 * Determines whether a value looks like a TypeScript compiler node.
 *
 * This is intentionally structural because compiler nodes are not exposed as
 * a single stable runtime class suitable for `instanceof`.
 */
export function isTsNode(value: unknown): value is ts.Node {
	if (value === null || typeof value !== "object") {
		return false;
	}

	if (ts.isSourceFile(value as ts.Node)) {
		return true;
	}

	const node = value as Partial<ts.Node>;
	const constructorName = getConstructorName(value);

	return (
		constructorName === "NodeObject" ||
		(
			typeof node.kind === "number" &&
			typeof node.pos === "number" &&
			typeof node.end === "number"
		)
	);
}

/**
 * Determines whether a value looks like a TypeScript compiler symbol.
 */
export function isTsSymbol(value: unknown): value is ts.Symbol {
	if (value === null || typeof value !== "object") {
		return false;
	}

	if (getConstructorName(value) === "SymbolObject") {
		return true;
	}

	const symbol = value as Partial<ts.Symbol> &
		Record<string, unknown>;

	if (typeof symbol.flags !== "number") {
		return false;
	}

	if (!("escapedName" in symbol)) {
		return false;
	}

	return (
		typeof symbol.name === "string" ||
		Array.isArray(symbol.declarations) ||
		typeof symbol.valueDeclaration === "object" ||
		typeof symbol.members === "object" ||
		typeof symbol.exports === "object"
	);
}

/**
 * Determines whether a value looks like a TypeScript compiler type.
 *
 * TypeScript types are compiler implementation objects rather than instances
 * of a stable public runtime class, so this combines the common constructor
 * name with a conservative structural fallback.
 */
export function isTsType(value: unknown): value is ts.Type {
	if (value === null || typeof value !== "object") {
		return false;
	}

	if (getConstructorName(value) === "TypeObject") {
		return true;
	}

	const type = value as Partial<InternalType> &
		Record<string, unknown>;

	if (typeof type.flags !== "number") {
		return false;
	}

	/*
	 * Nodes and symbols also contain flags, so explicitly exclude their
	 * characteristic properties.
	 */
	if ("kind" in type || "escapedName" in type) {
		return false;
	}

	return (
		"objectFlags" in type ||
		"intrinsicName" in type ||
		"aliasSymbol" in type ||
		"aliasTypeArguments" in type ||
		"typeArguments" in type ||
		"baseTypes" in type ||
		"constraint" in type
	);
}

/* ============================================================================
 * Error handling helpers
 * ========================================================================== */

/**
 * Executes an optional compiler inspection operation without allowing it to
 * abort serialization.
 */
function tryGet<T>(
	callback: () => T,
	onError?: (error: unknown) => void,
): T | undefined {
	try {
		return callback();
	} catch (error) {
		onError?.(error);
		return undefined;
	}
}

/**
 * Converts an unknown caught value into readable serialized error metadata.
 */
function serializeError(
	error: unknown,
	context?: string,
): SerializedError {
	if (error instanceof Error) {
		return {
			$type: "SerializationError",
			message: error.message,
			name: error.name,
			stack: error.stack,
			context,
		};
	}

	return {
		$type: "SerializationError",
		message: String(error),
		context,
	};
}

/* ============================================================================
 * Compiler graph serializer
 * ========================================================================== */

/**
 * Explicit graph serializer for TypeScript compiler nodes, symbols, and types.
 *
 * Shared objects receive stable IDs. Repeated occurrences become `$ref`
 * references instead of disappearing, preserving graph topology and
 * preventing cycles without losing legitimate shared references.
 */
export class SymbolSerializer {
	private readonly options: ResolvedSymbolSerializerOptions;

	private readonly objectIds = new WeakMap<object, number>();

	private nextObjectId = 1;

	public constructor(
		private readonly checker?: ts.TypeChecker,
		options: SymbolSerializerOptions = {},
	) {
		this.options = {
			...DEFAULT_OPTIONS,
			...options,
		};

		if (
			!Number.isFinite(this.options.maxDepth) ||
			this.options.maxDepth < 0
		) {
			throw new RangeError(
				"SymbolSerializerOptions.maxDepth must be a finite, non-negative number.",
			);
		}
	}

	/**
	 * Normalizes a compiler object graph into JSON-safe DTOs.
	 */
	public serialize(value: unknown): SerializedValue {
		return this.serializeValue(value, 0, true);
	}

	/**
	 * Normalizes and stringifies a compiler object graph.
	 */
	public stringify(value: unknown): string {
		return JSON.stringify(
			this.serialize(value),
			(_key, currentValue: unknown) => {
				if (typeof currentValue === "bigint") {
					return currentValue.toString();
				}

				return currentValue;
			},
			this.options.indent,
		);
	}

	private serializeValue(
		value: unknown,
		depth: number,
		isRootSymbol: boolean,
	): SerializedValue {
		if (
			value === null ||
			value === undefined ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			typeof value === "bigint"
		) {
			return value;
		}

		if (typeof value === "symbol") {
			return value.description ?? value.toString();
		}

		if (typeof value === "function") {
			return `[Function ${value.name || "anonymous"}]`;
		}

		if (typeof value !== "object") {
			return String(value);
		}

		const existingId = this.objectIds.get(value);

		if (existingId !== undefined) {
			return {
				$ref: existingId,
			};
		}

		if (depth > this.options.maxDepth) {
			return {
				$type: "SerializationError",
				message:
					`Maximum serialization depth of ` +
					`${this.options.maxDepth} exceeded.`,
				context: getConstructorName(value),
			};
		}

		const objectId = this.nextObjectId++;
		this.objectIds.set(value, objectId);

		try {
			if (isTsNode(value)) {
				return this.serializeNode(value, objectId);
			}

			if (isTsSymbol(value)) {
				return this.serializeSymbol(
					value,
					objectId,
					depth,
					isRootSymbol,
				);
			}

			if (isTsType(value)) {
				return this.serializeType(
					value,
					objectId,
					depth,
				);
			}

			if (value instanceof Map) {
				return this.serializeMap(
					value,
					objectId,
					depth,
				);
			}

			if (value instanceof Set) {
				return this.serializeSet(
					value,
					objectId,
					depth,
				);
			}

			if (Array.isArray(value)) {
				return this.serializeArray(
					value,
					objectId,
					depth,
				);
			}

			return this.serializePlainObject(
				value,
				objectId,
				depth,
			);
		} catch (error) {
			return serializeError(
				error,
				`Serializing ${
					getConstructorName(value) ?? "object"
				}`,
			);
		}
	}

	private serializeNode(
		node: ts.Node,
		objectId: number,
	): SerializedNode {
		const sourceFile = tryGet(() => node.getSourceFile());

		return {
			$id: objectId,
			$type: "Node",

			kind: {
				raw: node.kind,
				name: getExactEnumName(
					node.kind,
					ts.SyntaxKind,
				),
			},

			flags: serializeFlags(
				node.flags,
				ts.NodeFlags,
				ts.NodeFlags.None,
			),

			fileName: sourceFile?.fileName,
			pos: node.pos,
			end: node.end,

			text: this.options.includeNodeText
				? tryGet(() => printNode(node))
				: undefined,
		};
	}

	private serializeSymbol(
		symbol: ts.Symbol,
		objectId: number,
		depth: number,
		isRootSymbol: boolean,
	): SerializedSymbol {
		const internalSymbol = symbol as InternalSymbol;

		const serialized: SerializedSymbol = {
			$id: objectId,
			$type: "Symbol",

			name: symbol.name,
			escapedName: String(symbol.escapedName),

			flags: serializeFlags(
				symbol.flags,
				ts.SymbolFlags,
				ts.SymbolFlags.None,
			),
		};

		if (
			this.checker &&
			this.options.includeSymbolType
		) {
			const type = tryGet(() =>
				this.checker!.getTypeOfSymbol(symbol),
			);

			if (type !== undefined) {
				serialized.type = this.serializeValue(
					type,
					depth + 1,
					false,
				);
			}
		}

		if (
			this.checker &&
			this.options.includeDeclaredType
		) {
			const declaredType = tryGet(() =>
				this.checker!.getDeclaredTypeOfSymbol(symbol),
			);

			if (declaredType !== undefined) {
				serialized.declaredType =
					this.serializeValue(
						declaredType,
						depth + 1,
						false,
					);
			}
		}

		if (this.options.includeSymbolTables) {
			if (symbol.members) {
				serialized.members = this.serializeValue(
					symbol.members,
					depth + 1,
					false,
				);
			}

			if (symbol.exports) {
				serialized.exports = this.serializeValue(
					symbol.exports,
					depth + 1,
					false,
				);
			}

			if (internalSymbol.globalExports) {
				serialized.globalExports =
					this.serializeValue(
						internalSymbol.globalExports,
						depth + 1,
						false,
					);
			}
		}

		if (internalSymbol.exportSymbol) {
			serialized.exportSymbol = this.serializeValue(
				internalSymbol.exportSymbol,
				depth + 1,
				false,
			);
		}

		if (this.options.includeDeclarations) {
			if (symbol.declarations) {
				serialized.declarations =
					this.serializeValue(
						symbol.declarations,
						depth + 1,
						false,
					);
			}

			if (symbol.valueDeclaration) {
				serialized.valueDeclaration =
					this.serializeValue(
						symbol.valueDeclaration,
						depth + 1,
						false,
					);
			}
		}

		if (
			typeof internalSymbol.isReferenced === "number" &&
			internalSymbol.isReferenced !== 0
		) {
			serialized.isReferenced = serializeFlags(
				internalSymbol.isReferenced,
				ts.SymbolFlags,
				ts.SymbolFlags.None,
			);
		}

		if (
			isRootSymbol &&
			this.options.includeRootSymbolParent &&
			internalSymbol.parent
		) {
			serialized.parent = this.serializeValue(
				internalSymbol.parent,
				depth + 1,
				false,
			);
		}

		return serialized;
	}

	private serializeType(
		type: ts.Type,
		objectId: number,
		depth: number,
	): SerializedType {
		const internalType = type as InternalType;

		const serialized: SerializedType = {
			$id: objectId,
			$type: "Type",

			flags: serializeFlags(
				type.flags,
				ts.TypeFlags
			),
		};

		if (hasAnyFlag(type.flags, ts.TypeFlags.Object)) {
			const objectType = type as ts.ObjectType;

			serialized.objectFlags = serializeFlags(
				objectType.objectFlags,
				ts.ObjectFlags,
				ts.ObjectFlags.None,
			);
		}

		if (this.checker) {
			serialized.display = tryGet(() =>
				this.checker!.typeToString(
					type,
					undefined,
					ts.TypeFormatFlags.NoTruncation,
				),
			);
		}

		if (typeof internalType.intrinsicName === "string") {
			serialized.intrinsicName =
				internalType.intrinsicName;
		}

		if (internalType.symbol) {
			serialized.symbol = this.serializeValue(
				internalType.symbol,
				depth + 1,
				false,
			);
		}

		if (internalType.aliasSymbol) {
			serialized.aliasSymbol = this.serializeValue(
				internalType.aliasSymbol,
				depth + 1,
				false,
			);
		}

		if (internalType.aliasTypeArguments) {
			serialized.aliasTypeArguments =
				this.serializeValue(
					internalType.aliasTypeArguments,
					depth + 1,
					false,
				);
		}

		if (internalType.typeArguments) {
			serialized.typeArguments =
				this.serializeValue(
					internalType.typeArguments,
					depth + 1,
					false,
				);
		}

		if (internalType.baseTypes) {
			serialized.baseTypes = this.serializeValue(
				internalType.baseTypes,
				depth + 1,
				false,
			);
		}

		if (internalType.constraint) {
			serialized.constraint = this.serializeValue(
				internalType.constraint,
				depth + 1,
				false,
			);
		}

		if (internalType.default) {
			serialized.defaultType = this.serializeValue(
				internalType.default,
				depth + 1,
				false,
			);
		}

		return serialized;
	}

	private serializeMap(
		map: ReadonlyMap<unknown, unknown>,
		objectId: number,
		depth: number,
	): SerializedMap {
		return {
			$id: objectId,
			$type: "Map",

			entries: Array.from(
				map.entries(),
				([key, value]) => ({
					key: this.serializeValue(
						key,
						depth + 1,
						false,
					),

					value: this.serializeValue(
						value,
						depth + 1,
						false,
					),
				}),
			),
		};
	}

	private serializeSet(
		set: ReadonlySet<unknown>,
		objectId: number,
		depth: number,
	): SerializedSet {
		return {
			$id: objectId,
			$type: "Set",

			values: Array.from(
				set.values(),
				(value) =>
					this.serializeValue(
						value,
						depth + 1,
						false,
					),
			),
		};
	}

	private serializeArray(
		array: readonly unknown[],
		objectId: number,
		depth: number,
	): SerializedArray {
		return {
			$id: objectId,
			$type: "Array",

			values: array.map((value) =>
				this.serializeValue(
					value,
					depth + 1,
					false,
				),
			),
		};
	}

	private serializePlainObject(
		value: object,
		objectId: number,
		depth: number,
	): SerializedPlainObject {
		const properties: Record<
			string,
			SerializedValue
		> = {};

		if (this.options.includePlainObjects) {
			for (const key of Object.keys(value).sort()) {
				let propertyValue: unknown;

				try {
					propertyValue = (
						value as Record<string, unknown>
					)[key];
				} catch (error) {
					properties[key] = serializeError(
						error,
						`Reading property ${key}`,
					);

					continue;
				}

				properties[key] = this.serializeValue(
					propertyValue,
					depth + 1,
					false,
				);
			}
		}

		return {
			$id: objectId,
			$type: "Object",
			constructorName: getConstructorName(value),
			properties,
		};
	}
}

/* ============================================================================
 * SourceFile entry point
 * ========================================================================== */

/**
 * Serializes symbols associated with a TypeScript source file.
 *
 * This function reads `sourceFile.locals`, which is an internal compiler
 * property. The source-file symbol is included only when present.
 *
 * @param sourceFile - Source file whose symbols should be serialized.
 * @param program - Optional program used to obtain a TypeChecker.
 * @param options - Serializer output and traversal options.
 * @returns JSON containing the normalized compiler object graph.
 */
export function sourceFileAST(
	sourceFile: ts.SourceFile,
	program?: ts.Program,
	options: SymbolSerializerOptions = {},
): string {
	const internalSourceFile =
		sourceFile as InternalSourceFile;

	const symbols: ts.Symbol[] = [];

	if (internalSourceFile.locals) {
		symbols.push(
			...internalSourceFile.locals.values(),
		);
	}

	if (internalSourceFile.symbol) {
		symbols.push(internalSourceFile.symbol);
	}

	const serializer = new SymbolSerializer(
		program?.getTypeChecker(),
		options,
	);

	return serializer.stringify(symbols);
}