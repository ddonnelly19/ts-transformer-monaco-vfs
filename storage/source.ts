
declare namespace Packages.com.glide.script.system {
	interface GlideSystemUtilDBConstructor {
		new (...args: any[]): GlideSystemUtilDB;
	}
	interface GlideSystemUtilDB {}
}

declare namespace Packages.com.glide.script.system {
	class GlideSystemUtilDB {}
	class GlideSystemDateUtil2 {
		constructor();
		nowDateTime(): string;
		nowGlideDateTime(): GlideDateTime;
		nowNoTZ(): string;
		lastWeek(): string;
		datePart(interval: string, value: string, oper: string): string;
		now(): string;
		beginningOfToday(): string;
		beginningOfDay(o: any): string;
		endOfToday(): string;
		endOfDay(o: any): string;
		beginningOfYesterday(): string;
		beginningOfTomorrow(): string;
		endOfYesterday(): string;
		endOfTomorrow(): string;
		beginningOfThisWeek(): string;
		beginningOfWeek(o: any): string;
		endOfThisWeek(): string;
		endOfWeek(o: any): string;
		beginningOfLastWeek(): string;
		endOfLastWeek(): string;
		beginningOfNextWeek(): string;
		endOfNextWeek(): string;
		beginningOfThisMonth(): string;
		beginningOfMonth(o: any): string;
		endOfThisMonth(): string;
		endOfMonth(o: any): string;
		beginningOfLastMonth(): string;
		monthsAgo(month: NumberLike): string;
		monthsAgoStart(month: NumberLike): string;
		monthsAgoEnd(month: NumberLike): string;
		endOfLastMonth(): string;
		beginningOfNextMonth(): string;
		endOfNextMonth(): string;
		beginningOfThisQuarter(): string;
		endOfThisQuarter(): string;
		quartersAgo(quarters: NumberLike): string;
		quartersAgoStart(quarters: NumberLike): string;
		quartersAgoEnd(quarters: NumberLike): string;
		yearsAgo(year: NumberLike): string;
		beginningOfLastYear(): string;
		endOfLastYear(): string;
		beginningOfNextYear(): string;
		endOfNextYear(): string;
		beginningOfThisYear(): string;
		beginningOfYear(o: any): string;
		endOfThisYear(): string;
		endOfYear(o: any): string;
		daysAgo(days: NumberLike): string;
		daysAgoLocal(days: NumberLike): string;
		daysAgoStart(days: NumberLike): string;
		daysAgoEnd(days: NumberLike): string;
		hoursAgo(hours: NumberLike): string;
		hoursAgoLocal(hours: NumberLike): string;
		hoursAgoStart(hours: NumberLike): string;
		hoursAgoEnd(hours: NumberLike): string;
		minutesAgo(minutes: NumberLike): string;
		minutesAgoStart(minutes: NumberLike): string;
		minutesAgoEnd(minutes: NumberLike): string;
		yesterday(): string;
		getDurationDate(duration: string): string;
		dateGenerate(date: GlideDateTimeLike, range: string): string;
		dateDiff(startDate: GlideDateTimeLike, endDate: GlideDateTimeLike): GlideDateTimeLike;
		dateDiff(startDate: GlideDateTimeLike, endDate: GlideDateTimeLike, bnumericValue: true): number;
		calDateDiff(startDate: GlideDateTimeLike, endDate: GlideDateTimeLike, numericValue: BooleanLike): GlideDateTimeLike;
		isFirstDayOfWeek(o: any): boolean;
		isLastDayOfWeek(o: any): boolean;
		isFirstDayOfMonth(o: any): boolean;
		isLastDayOfMonth(o: any): boolean;
		isFirstDayOfYear(o: any): boolean;
		isLastDayOfYear(o: any): boolean;
		dateAdd(unit: string, offset: NumberLike, basis: any): string;
		calDateDiff(startDate: string, endDate: string, numericValue: BooleanLike): string;
		dateDiff(startDate: string, endDate: string, bnumericValue: BooleanLike): string;
		dateGenerate(date: string, range: string): string;
		now(): StringType<globalThis.GlideDate>;
		nowDateTime(): StringType<GlideDateTime>;
	}

	export class GlideSystemDateUtil3 {
		constructor();
		beginningOfLast3Months(): string;
		endOfLast3Months(): string;
		beginningOfLast6Months(): string;
		endOfLast6Months(): string;
		beginningOfLast9Months(): string;
		endOfLast9Months(): string;
		beginningOfLast12Months(): string;
		endOfLast12Months(): string;
		beginningOfLastQuarter(): string;
		endOfLastQuarter(): string;
		beginningOfLast2Quarters(): string;
		endOfLast2Quarters(): string;
		beginningOfNextQuarter(): string;
		endOfNextQuarter(): string;
		beginningOfNext2Quarters(): string;
		endOfNext2Quarters(): string;
		beginningOfLast2Years(): string;
		endOfLast2Years(): string;
		beginningOfLast7Days(): string;
		endOfLast7Days(): string;
		beginningOfLast30Days(): string;
		endOfLast30Days(): string;
		beginningOfLast60Days(): string;
		endOfLast60Days(): string;
		beginningOfLast90Days(): string;
		endOfLast90Days(): string;
		beginningOfLast120Days(): string;
		endOfLast120Days(): string;
		beginningOfCurrentHour(): string;
		endOfCurrentHour(): string;
		beginningOfLastHour(): string;
		endOfLastHour(): string;
		beginningOfLast2Hours(): string;
		endOfLast2Hours(): string;
		beginningOfCurrentMinute(): string;
		endOfCurrentMinute(): string;
		beginningOfLastMinute(): string;
		endOfLastMinute(): string;
		beginningOfLast15Minutes(): string;
		endOfLast15Minutes(): string;
		beginningOfLast30Minutes(): string;
		endOfLast30Minutes(): string;
		beginningOfLast45Minutes(): string;
		endOfLast45Minutes(): string;
		beginningOfOneYearAgo(): string;
		endOfOneYearAgo(): string;
	}
}

declare class GlideSystemUtilDB {
	static dropTable(arg0: table_name);
	static dropTableRecord(dbObject: GlideRecord<"sys_db_object">): void;
	_dropTable<T extends table_name>(tableName: T): void;
	alterSqlFieldDefintion(table: string, element: string, oldLength: any): void;
	dropColumn<T extends table_name>(tableName: T, fieldName: field_name<T>): void;
	dropColumnQuick<T extends table_name>(tableName: T, fieldName: string): void;
	dropTable<T extends table_name>(tableName: T): void;
	dropTableRecord(dbObject: GlideRecord<"sys_db_object">): void;
	ensureCompositeIndex(tableName: string, sfields: string, indexName: string): void;
	ensureIndex(tableName: string, elementName: string): boolean;
	fieldExists(tableName: string, fieldName: string): boolean;
	flushStatus(): void;
	getDictionaryEntryPackage(tableName: string, fieldName: string): string;
	getDictionaryEntryScope(tableName: string, fieldName: string): string;
	getDisplayValueFor(table: string, key: string, field: string): string;
	getInScopeDBViews(): GlideStringList;
	getInScopeTables(): GlideStringList;
	healthCheck(filePattern: string, reportonly: BooleanLike): boolean;
	isScopedAdminApp(): boolean;
	isScopedApp(): boolean;
	isTableInScope(tableName: string): boolean;
	rebuildAllIndexes(): void;
	rebuildIndexes(tableName: string): void;
	renameTable(tableName: string, newTableName: string, cacheFlush: BooleanLike): void;
	reset(): boolean;
	resetDB(dbName: string): void;
	sql(statement: string): void;
	sqlItemsByField(table: string, sfields: any, fwfield: string, value: string, limit: NumberLike): Packages.java.util.ArrayList<any>;
	sqlItemsByID(table: string, sfields: any, sys_id: string, limit: NumberLike): Packages.java.util.ArrayList<any>;
	tableCreate(name: table_name, label: any): string;
	tableDrop(name: table_name): void;
	trace(onOff: BooleanLike): void;
	truncateTable(name: table_name): void;
}
