type ObjectEntry<T extends object> = {
	[K in Extract<keyof T, string>]-?: readonly [K, T[K]];
}[Extract<keyof T, string>];

/**
 * Return a set of properties from T where T[property] extends V
 */
type PickKeys<T, V> = Extract<keyof PickType<T, V>, keyof T>;

/**
 * From T, pick a set of properties whose values extend V
 */
type PickType<T, V> = {
	[K in keyof T as Extract<T[K], V> extends never ? never : K]: Extract<T[K], V>;
};


interface ObjectConstructor {
	entries<T extends object>(object: T): Array< {
	[K in Extract<keyof T, string>]-?: readonly [K, T[K]];
}[Extract<keyof T, string>]>;
}
