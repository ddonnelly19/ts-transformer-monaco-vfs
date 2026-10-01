// @ts-check
CG_StringUtils;
CG_ObjectUtils;

const CG_DuplicateUtils = /** @class */ (function () {
    class CG_DuplicateUtils {
        static IdentifierError = class IdentifierError extends Error {
            constructor(identifier, error) {
                super(error);
                this.identifier = identifier;
            }
        };
        /**
      * @type {field_full_name<table_name, ".">[]}
      */
        static blacklist = gs.getProperty("glide.duplicate_ci_remediator.related_items_blacklist", "")
            .split(",")
            .concat([
                "cmdb_datasource_last_update.cmdb_ci",
                "ts_document.document_id",
                "duplicate_audit_result.duplicate_ci",
                "sys_object_source.target_sys_id",
                "fx_currency_instance.id",
                "sys_execution_tracker.source",
                "sys_rollback_sequence.document_id",
                "sys_rollback_incremental.document_id",
                "cmdb_duplicate_ci_remediation.master_ci",
                "cmdb_health_result.ci",
                "sys_history_set.id",
                "sn_vul_m2m_ci_services.item",
                "sn_vul_vulnerable_item.location",
                "sys_audit_delete.documentkey",
                "cmdb_ci.duplicate_of",
                "sys_audit.documentkey",
                "sys_audit_relation.documentkey",
                "cert_audit_result.configuration_item",
                "cert_audit_result.id",
                "reconcile_duplicate_task.u_master_record",
                "sys_watermark.source_id"
            ])
            .concat(CG_TableUtils.ignoreTables)
            .unique()
            .sort();
        /**
             *
             * @param {GlideRecord<"reconcile_duplicate_task">} taskGr
             * @param {boolean} [doUpdate]
             */
        static getMasterRecordForTask(taskGr, doUpdate) {
            try {
                if (doUpdate)
                    taskGr.get(taskGr.getUniqueValue());
                if (!taskGr.active || taskGr.state == 2)
                    return taskGr;
                var curState = `${taskGr.state}`;
                /** @type {SysId<table_name>[]} */
                var sys_ids = CG_DuplicateUtils.getDuplicateIDsForTask(taskGr.getUniqueValue());
                if (sys_ids.length < 2) {
                    return taskGr;
                }
                /** @type {table_name} */
                var master_table = CG_DuplicateUtils.getMasterTableForTask(taskGr.getUniqueValue());
                if (JSUtil.nil(master_table))
                    return taskGr;
                taskGr.u_master_table = master_table;
                try {
                    var rec = CG_DuplicateUtils.findMasterRecord(master_table, sys_ids);
                    if (rec.sys_id == null) {
                        taskGr.u_master_record = "NULL";
                        taskGr.u_master_identifier = "NULL";
                        taskGr.state = -5;
                        doUpdate && taskGr.update();
                    }
                    else {
                        /*sys_ids.forEach(function(id) {
                            var gr = new GlideRecord(master_table);
                            if (gr.get(id) && gr.isValidField("u_merged_master")) {
                                gr.u_merged_master = rec.sys_id == id ? "NULL" : rec.sys_id;
                                gr.update();
                            }
                        });*/
                        if (taskGr.u_master_record != rec.sys_id)
                            taskGr.work_notes = `[code]Set Master Record ${CG_RecordUtils.getRecordUrl(rec.sys_id, master_table)} by ${rec.identifier ? CG_RecordUtils.getRecordUrl(rec.identifier, "u_master_record_identifiers") : "default rule"}[/code]`;
                        taskGr.state = 1;
                        taskGr.u_master_record = rec.sys_id;
                        taskGr.u_master_identifier = rec.identifier;
                        doUpdate && taskGr.update();
                    }
                }
                catch (ex) {
                    var ex2 = ex;
                    if (!taskGr.u_master_record.nil() || curState != "-5" || taskGr.work_notes.getJournalEntry(-1).indexOf(`${ex}`) < 0)
                        taskGr.work_notes = (`Error setting Master Record: ${ex}`).fontcolor("red").bold().code();
                    taskGr.state = -5;
                    taskGr.u_master_record = "NULL";
                    taskGr.u_master_identifier = !!ex.identifier ? ex.identifier : "NULL";
                    doUpdate && taskGr.update();
                }
            }
            catch (ex) {
                gs.error(`getMasterRecordForTask for ${taskGr.getDisplayValue()}: ${ex}`);
            }
            if (doUpdate)
                taskGr.get(taskGr.sys_id);
            return taskGr;
        }
        /**
             *
             * @param {SysId<"reconcile_duplicate_task">} taskID
             * @returns
             */
        static getMasterTableForTask(taskID) {
            var gr = new GlideRecord("duplicate_audit_result");
            gr.addQuery("follow_on_task", taskID);
            gr.setWorkflow(false);
            gr.query();
            /** @type {table_name[]} */
            var tables = [];
            while (gr.next()) {
                var dupGr = gr.duplicate_ci.getRefRecord();
                if (!dupGr || !dupGr.isValidRecord())
                    gr.deleteRecord();
                else
                    tables.push(dupGr.getRecordClassName());
            }
            var tbl = CG_TableUtils.getCommonTable(tables.unique());
            try {
                CG_CMDBIdentifier.createIREList(tbl);
            }
            catch (ex) {
            }
            return tbl;
        }
        /**
             *
             * @param {SysId<"reconcile_duplicate_task">} taskID
             * @returns {SysId<any>[]}
             */
        static getDuplicateIDsForTask(taskID) {
            var ids = [];
            //var taskGr = new GlideRecord("reconcile_duplicate_task");
            //if (taskGr.get(taskID) && taskGr.active && taskGr.state != 2) {
            //var taskCnt = taskGr.duplicate_count;
            var dupGr = new GlideRecord("duplicate_audit_result");
            dupGr.addQuery("follow_on_task", taskID);
            dupGr.setWorkflow(false);
            dupGr.query();
            while (dupGr.next()) {
                var refGr = dupGr.duplicate_ci.getRefRecord();
                if (!refGr || !refGr.isValidRecord())
                    dupGr.deleteRecord();
                else
                    ids.push(`${dupGr.duplicate_ci}`);
            }
            /*if (taskCnt != ids.length) {
                taskGr.setForceUpdate(true);
                taskGr.update();
            }*/
            return ids;
        }
        /**
             * @template {table_name} T
             * @param {GlideStringQuery<T>} condition
             * @returns {(master_table: T, sys_ids: SysId<T>[]) => SysId<T> | null}
             */
        static evaluateCondition(condition) {
            return function (master_table, sys_ids) {
                var gr = new GlideRecord(master_table);
                gr.addEncodedQuery(condition);
                var queryDisp = CG_RecordUtils.getQueryDisplay(gr);
                gr.addQuery("sys_id", "IN", sys_ids);
                var ids = getSubQuery(master_table, "sys_id", gr.getEncodedQuery());
                var count = ids.length;
                //gs.addInfoMessage(CG_RecordUtils.getRecordListUrl(gr, true));
                if (count == 1) {
                    return ids[0];
                }
                if (count > 1)
                    throw new Error(`Returned multiple results for ${queryDisp}: ${ids.join(", ")}`);
                return null;
            };
        }
        /**
             * @template {table_name} T
             * @param {T} master_table
             * @param {SysId<T>[]} sys_ids
             * @param {{"u_table": T | "global", "u_order": number, "u_conditions"?: GlideStringQuery<T>, "u_script"?: FunctionString<(table_name: T, sys_ids: SysId<T>[]) => SysId<T>>, "u_type": "condition" | "script" ,"u_name": string, sys_id?: SysId<"u_master_record_identifiers">, u_ignore_multiple: boolean}[]} [identifiers]
             * @returns {{ identifier?: SysId<"u_master_record_identifiers">; sys_id: SysId<T>; }}
             */
        static findMasterRecord(master_table, sys_ids, identifiers) {
            if (sys_ids.length <= 0 || JSUtil.nil(master_table)) {
                return /** @type {const} */ ({
                    sys_id: null,
                    identifier: null
                });
            }
            if (sys_ids.length == 1)
                return /** @type {const} */ ({
                    sys_id: sys_ids[0],
                    identifier: null
                });
            identifiers = identifiers || CG_DuplicateUtils.getMasterIdentifiers(master_table);
            //gs.addInfoMessage(sys_ids + "");
            for (var i = 0; i < identifiers.length; i++) {
                var identifier = identifiers[i];
                //gs.addInfoMessage(JSON.stringify(identifier));
                /** @type {Function | ((table_name: T, sys_ids: SysId<T>[]) => SysId<T> | null)} */
                var predicate;
                switch (identifier.u_type) {
                    case "condition":
                        predicate = CG_DuplicateUtils.evaluateCondition(identifier.u_conditions);
                        break;
                    case "script":
                        predicate = new Function("table_name", "sys_ids", `return ${identifier.u_script}`);
                        break;
                    default:
                        break;
                }
                /** @type {SysId<T>} */
                var sys_id;
                try {
                    sys_id = predicate(master_table, sys_ids);
                }
                catch (ex) {
                    if (!identifier.u_ignore_multiple)
                        throw new CG_DuplicateUtils.IdentifierError(identifier.sys_id, `${ex}`);
                }
                //gs.addInfoMessage(sys_id + ": " + predicate + "");
                if (!!sys_id) {
                    return /** @type {const} */ ({
                        identifier: identifier.sys_id,
                        sys_id: sys_id
                    });
                }
            }
            return /** @type {const} */ ({
                sys_id: null
            });
        }
        /**
             * @template {table_name | "global"} T
             * @param {table_name} master_table
             */
        static getMasterIdentifiers(master_table) {
            /** @type {{"u_table": T, "u_order": number, "u_conditions": GlideStringQuery<T>, "u_script": FunctionString<(table_name: T, sys_ids: SysId<T>[]) => SysId<T>>, "u_type": "condition" | "script" ,"u_name": string, sys_id: SysId<"u_master_record_identifiers">, "u_ignore_multiple": boolean}[]} */
            var ret = new GlideQuery("u_master_record_identifiers")
                .where("u_table", master_table)
                .where("u_active", true)
                .orderBy("u_order")
                .select("u_table", "u_order", "u_conditions", "u_script", "u_type", "u_name", "u_ignore_multiple")
                .reduce(function (/** @type {Partial<GlideQueryResult<"u_table" | "u_order" | "u_conditions" | "u_script" | "u_type" | "u_name" | "u_ignore_multiple", "u_master_record_identifiers">>[]} */ state, curr) {
                    if (curr.u_type == "condition")
                        delete curr.u_script;
                    else if (curr.u_type == "script")
                        delete curr.u_conditions;
                    state.push(curr);
                    return state;
                }, []);
            // gs.addInfoMessage("getMasterIdentifiers: " + master_table + ": " + ret.length);
            if (master_table != "global") {
                var parentClass = /** @type {parentclass<T>} */ (`${GlideDBObjectManager.get().getBase(master_table)}`);
                if (parentClass != (`${master_table}`)) {
                    ret = ret.concat(CG_DuplicateUtils.getMasterIdentifiers(parentClass));
                }
                else {
                    ret = ret.concat(CG_DuplicateUtils.getMasterIdentifiers("global"));
                }
            }
            return ret;
        }
        /**
             * @template {table_name} T
             * @param {T} table_name
             * @param {SysId<T>[]} sys_ids
             * @returns {SysId<T> | null}
             */
        static getMostReferences(table_name, sys_ids) {
            var refs = new GlideQuery(table_name)
                .where("sys_id", "IN", sys_ids)
                .select()
                .map(function (rec) {
                    var gr = new GlideRecord(table_name);
                    return gr.get(rec.sys_id) ? GlideScriptRecordUtil.get(gr).getRealRecord() : null;
                })
                .filter(function (a) {
                    return !!a;
                })
                .map(function (gr) {
                    var refRecords = CG_RecordUtils.getReferencedRecords(gr, CG_DuplicateUtils.blacklist);
                    var cnt = 0;
                    for (var prop in refRecords) {
                        cnt = cnt + refRecords[prop].length;
                    }
                    return /** @type {const} */ ({
                        sys_id: `${gr.getUniqueValue()}`,
                        count: cnt
                    });
                })
                .reduce(function (state, curr) {
                    state.push(curr);
                    return state;
                }, [])
                .sort(function (a, b) {
                    return b.count - a.count;
                });
            if (refs.filter(function (a) {
                return a.count == refs[0].count;
            }).length > 1)
                return null;
            return refs[0].sys_id;
        }
        /**
             * Automatically merges duplicates from a Duplicate CI task record
             * @template {table_name} T
             * @param {SysId<"reconcile_duplicate_task"> | GlideRecord<'reconcile_duplicate_task'>} _taskGr
             * @param {"DELETE" | "UPDATE"} [duplicate_ci_action]
             * @param {{ element: field_name<T>; element_label?: string; value: string; display?: string; }[]} [duplicate_ci_updates]
             */
        static processDuplicateTask(_taskGr, duplicate_ci_action, duplicate_ci_updates) {
            var taskGr = CG_RecordUtils.getRecord(_taskGr, "reconcile_duplicate_task");
            if (!taskGr)
                return;
            try {
                if (!CG_DuplicateUtils.checkDuplicateTask(taskGr.getUniqueValue())) {
                    return;
                }
            }
            catch (ex) {
            }
            CG_DuplicateUtils.getDuplicateIDsForTask(taskGr.getUniqueValue());
            taskGr.get(taskGr.getUniqueValue());
            if (!taskGr.active || taskGr.state == 2 || taskGr.u_master_record.nil())
                return;
            taskGr.setForceUpdate(true);
            taskGr.state = 2;
            taskGr.get(taskGr.update());
            taskGr.setForceUpdate(false);
            //taskGr = getMasterRecordForTask(taskGr, true);
            //taskGr.get(taskGr.getUniqueValue());
            if (!taskGr.active)
                return;
            if (taskGr.u_master_record.nil())
                throw new Error(`Master Record for ${taskGr.getDisplayValue()} not set`);
            var masterID = /** @type {SysId<T>} */ (`${taskGr.u_master_record}`);
            var master_table = /** @type {T} */ (`${taskGr.u_master_table}`);
            if (JSUtil.nil(master_table))
                throw new Error("Master Table not set");
            var masterGr = new GlideRecord(master_table);
            if (!masterGr.get(masterID)) {
                taskGr.u_master_table = "NULL";
                taskGr.u_master_record = "NULL";
                taskGr.update();
                throw new Error("Master Record is invalid");
            }
            //taskGr.state = 2;
            //taskGr.update();
            if (JSUtil.nil(duplicate_ci_action)) {
                var dupAction = gs.getProperty(`glide.duplicate_ci_remediator.update.${master_table}`);
                if (!!dupAction) {
                    duplicate_ci_action = "UPDATE";
                    duplicate_ci_updates = JSON.parse(dupAction);
                }
                else if (JSUtil.nil(duplicate_ci_action) || duplicate_ci_action == "DELETE") {
                    duplicate_ci_action = "DELETE";
                    duplicate_ci_updates = [];
                }
            }
            duplicate_ci_updates = duplicate_ci_updates
                .map(function (update) {
                    var gr = new GlideRecord(master_table);
                    gr.initialize();
                    var ele = gr.getElement(update.element);
                    if (JSUtil.notNil(ele)) {
                        ele.setValue(update.value);
                        update.element_label = `${ele.getLabel()}`;
                        update.display = `${ele.getDisplayValue()}`;
                    }
                    else {
                        update = null;
                    }
                    return update;
                }).filter(function (update) {
                    return !!update;
                });
            /*if (duplicate_ci_action == "UPDATE" && duplicate_ci_updates.length == 0)
                throw new Error("Duplicate CI Action is 'UPDATE' but no update values set");*/
            var ignoreField = ["duplicate_of", "sys_tags", "hash", "u_merged_master", "life_cycle_stage", "life_cycle_stage_status"];
            /** @type {SysId<T>[]} */
            var dupIDs = getSubQuery("duplicate_audit_result", "duplicate_ci", `follow_on_task=${taskGr.sys_id}^duplicate_ci!=${masterID}`);
            if (dupIDs.length < 1) {
                taskGr.state = 3;
                taskGr.update();
                return null;
            }
            var uniqueFields = CG_TableUtils.getUniqueFields(master_table);
            /** @type {field_name<T>[]} */
            var fields = GlideTableDescriptor.get(master_table).schemaList
                .toArray()
                .filter(function (ed) {
                    return ed.active && !ed.autoOrSysID && ignoreField.indexOf(`${ed.name}`) < 0 && uniqueFields.indexOf(`${ed.name}`) < 0;
                })
                .map(function (ed) {
                    return `${ed.name}`;
                })
                .sort();
            //var masterTableGr = new GlideRecord(master_table);
            //masterTableGr.initialize();
            //var defaultValues = CG_RecordUtils.populateFromGR(masterTableGr);
            var masterValues = new GlideQuery(master_table)
                .get(masterID, fields)
                .get();
            var uniqueValues = new GlideQuery(master_table)
                .where("sys_id", "IN", dupIDs)
                .select(uniqueFields)
                .reduce(function (/** @type {{[x: field_name<T>]: {[x:string]: SysId<T>[]}}} */ state, curr) {
                    Object.keys(curr)
                        .forEach(function (/** @type {field_name<T>} */ fieldName) {
                            if (fieldName != "sys_id" && JSUtil.notNil(curr[fieldName]) && JSUtil.nil(masterValues[fieldName])) {
                                if (!state[fieldName])
                                    state[fieldName] = {};
                                var state1 = state[fieldName];
                                if (!state1[curr[fieldName]])
                                    // @ts-ignore
                                    state1[curr[fieldName]] = [];
                                state1[curr[fieldName]].push(curr.sys_id);
                            }
                        });
                    return state;
                }, {});
            Object.keys(uniqueValues).forEach(function (/** @type {field_name<T>} */ curr) {
                var val = uniqueValues[curr];
                if (Object.keys(val).length == 1) {
                    var value = Object.keys(val)[0];
                    var gr = new GlideRecord(master_table);
                    if (gr.get(val[value][0])) {
                        gr[curr] = "NULL";
                        gr.update();
                    }
                    gr = new GlideRecord(master_table);
                    if (gr.get(masterID) && gr[curr].nil()) {
                        gr[curr] = value;
                        gr.update();
                    }
                }
            });
            var values = new GlideQuery(master_table)
                .where("sys_id", "IN", dupIDs)
                .select(fields)
                .reduce(function (/** @type {{[P in field_name<T>]?: {[x:string]: SysId<T>[]}}} */ state, curr) {
                    Object.keys(curr)
                        .forEach(function (/** @type {field_name<T>} */ fieldName) {
                            if (fieldName != "sys_id" && JSUtil.notNil(curr[fieldName]) && JSUtil.nil(masterValues[fieldName])) {
                                if (!state[fieldName])
                                    state[fieldName] = {};
                                var state1 = state[fieldName];
                                if (!state1[curr[fieldName]])
                                    // @ts-ignore
                                    state1[curr[fieldName]] = [];
                                state1[curr[fieldName]].push(curr.sys_id);
                            }
                        });
                    return state;
                }, {});
            var resolved_field_ci_map = Object.keys(values).reduce(function (/** @type {{element: field_name<T>; sys_id: SysId<T>}[]} */ state, curr) {
                var val = values[curr];
                if (Object.keys(val).length == 1) {
                    state.push({
                        element: curr,
                        sys_id: val[Object.keys(val)[0]][0]
                    });
                }
                return state;
            }, []);
            //return JSON.stringify(resolved_field_ci_map, null, "\t");
            var merge_relations = true;
            var duplicate_cis = dupIDs.reduce(function (/** @type {{[P in subclass<T>]?: SysId<T>[]}} */ state, curr) {
                var gr = new GlideRecord(master_table);
                if (gr.get(curr)) {
                    var className = gr.getRecordClassName();
                    if (!state[className])
                        state[className] = [];
                    state[className].push(curr);
                }
                return state;
            }, {});
            var related_tables_merged = dupIDs
                .reduce(function (state, dupId) {
                    return state.concat(Object.keys(CG_RecordUtils.getReferencedRecords(CG_RecordUtils.getRecordByID(dupId, master_table), CG_DuplicateUtils.blacklist, true)));
                }, [])
                .unique()
                .sort();
            return CG_DuplicateUtils.createDuplicateRemediation(taskGr, masterID, master_table, duplicate_ci_action, merge_relations, duplicate_cis, related_tables_merged, duplicate_ci_updates, resolved_field_ci_map);
        }
        /**
             * @template {table_name} T
             * @template {hierarchy<T> | T} H
             * @param {GlideRecord<"reconcile_duplicate_task">} taskGr
             * @param {SysId<T>} master_ci
             * @param {H} table
             * @param {"DELETE" | "UPDATE"} duplicate_ci_action
             * @param {boolean} merge_relations
             * @param {{ [P in hierarchy<T>]?: SysId<P>[] }} duplicate_cis
             * @param {field_full_name<table_name, ".">[]} related_tables_merged
             * @param { { element: field_name<H>; element_label?: string;	value: string; display?: string;	} []} duplicate_ci_updates
             * @param { { element: field_name<H>, sys_id: SysId<hierarchy<T>>; }[]} resolved_field_ci_map
             * @returns {SysId<"cmdb_duplicate_ci_remediation"> | null}
             */
        static createDuplicateRemediation(taskGr, master_ci, table, duplicate_ci_action, merge_relations, duplicate_cis, related_tables_merged, duplicate_ci_updates, resolved_field_ci_map) {
            var dupRemGr = new GlideRecord("cmdb_duplicate_ci_remediation");
            dupRemGr.initialize();
            dupRemGr.remediated_by = gs.getUserID();
            dupRemGr.task = taskGr.getUniqueValue();
            dupRemGr.master_ci = master_ci;
            dupRemGr.merge_relations = merge_relations;
            dupRemGr.duplicate_ci_action = duplicate_ci_action;
            dupRemGr.table = table;
            dupRemGr.related_tables_merged = global.JSON.stringify(related_tables_merged);
            dupRemGr.duplicate_cis = global.JSON.stringify(duplicate_cis);
            dupRemGr.resolved_field_ci_map = global.JSON.stringify(resolved_field_ci_map);
            dupRemGr.duplicate_ci_updates = global.JSON.stringify(duplicate_ci_updates);
            dupRemGr.state = "MERGING";
            var dupId = dupRemGr.insert();
            //updateTaskLog(taskGr, "Created " + CG_RecordUtils.getRecordUrl(dupRemGr));
            CG_DuplicateUtils.processDuplicateResolution(dupId);
            return dupId;
        }
        /**
             *
             * @param {SysId<"cmdb_duplicate_ci_remediation">} dupResID
             */
        static processDuplicateResolution(dupResID) {
            var dupRemGr = new GlideRecord("cmdb_duplicate_ci_remediation");
            if (dupRemGr.get(dupResID)) {
                if (CG_RecordUtils.getQueryCount("cmdb_duplicate_ci_remediation", `state=MERGING^task=${dupRemGr.task}^sys_id!=${dupResID}`) == 0)
                    new SNC.CMDBDuplicateMerger().processDuplicateResolution(dupResID);
                else
                    dupRemGr.deleteRecord();
            }
        }
        /**
             * Create Remediate Duplicate Task for given list of duplicate sysIds
             * @template {table_name} T
             * @param {SysId<T>[]} sysIDs
             * @param {T} tableName
             * @param {boolean} [runRemediation]
             * @param {string} [desc]
             * @param {string | string[]} [notes]
             * @param {undefined} [depId]
             * @param {undefined} [runId]
             * @returns {SysId<"reconcile_duplicate_task"> | null}
             */
        static createDuplicateTask(sysIDs, tableName, runRemediation, desc, notes, depId, runId) {
            var arrayUtil = new ArrayUtil();
            sysIDs = arrayUtil.ensureArray(sysIDs).unique();
            notes = arrayUtil.ensureArray(notes).filter(JSUtil.notNil);
            if (sysIDs.length < 2)
                return null;
            //var dupMutex = new GlideSelfCleaningMutex("createDuplicateTask: " + tableName + "," + sysIDs.sort().join(","));
            //try {
            //	if (dupMutex.get()) {
            var labels = [];
            /**
             * @type {Nullable<SysId<"reconcile_duplicate_task">>}
             */
            var taskId = getSubQuery("duplicate_audit_result", "follow_on_task", `follow_on_task.active=true^duplicate_ciIN${sysIDs.join(",")}`).find(function (id) {
                var ids = CG_DuplicateUtils.getDuplicateIDsForTask(id);
                return sysIDs.every(function (sysID) {
                    return ids.indexOf(sysID) >= 0;
                });
            });
            if (JSUtil.nil(taskId)) {
                // validate sysId is valid cmdb_ci and not present in any open de-duplicate tasks
                for (var i = 0; i < sysIDs.length; i++) {
                    var gr = new GlideRecord(tableName);
                    if (gr.get(sysIDs[i])) {
                        var gr2 = new GlideRecord("duplicate_audit_result");
                        gr2.addQuery("duplicate_ci", sysIDs[i]);
                        gr2.addQuery("follow_on_task.active", true);
                        //gr2.addQuery("follow_on_task.state", "!=", 50);
                        gr2.query();
                        while (gr2.next()) {
                            throw new Error(`Failed to create Remediate Duplicate Task. Following sysId is already part of an open Remediate Duplicate Tasks: {0}`);
                        }
                        labels.push(`${gr.getClassDisplayValue()}`);
                    }
                    else {
                        throw new Error(`Failed to create Remediate Duplicate Task. Following sysId is not a valid sysId in {0} table: {1}`);
                    }
                }
                labels = labels.unique();
                // Create Remediate Duplicate Task
                var taskGr = new GlideRecord("reconcile_duplicate_task");
                taskGr.initialize();
                //var shortDesc = "Duplicate records for " + tableName + ": " + labels.join(", ");						
                taskGr.setNewGuid();
                taskId = `${taskGr.sys_id}`;
                for (var j = 0; j < sysIDs.length; j++) {
                    // Create duplicate audit results
                    var grR = new GlideRecord("duplicate_audit_result");
                    grR.initialize();
                    grR.setValue("table", tableName);
                    grR.setValue("duplicate_ci", sysIDs[j]);
                    if (global.JSUtil.notNil(depId)) {
                        grR.setValue("duplicate_id", sysIDs[j] + depId);
                        grR.setValue("depend_on", depId);
                    }
                    else
                        grR.setValue("duplicate_id", sysIDs[j]);
                    grR.setValue("follow_on_task", taskId);
                    grR.insert();
                }
                taskGr = CG_DuplicateUtils.getMasterRecordForTask(taskGr, false);
                taskGr.short_description = `Duplicate records found in {0} class{1}: {2}`;
                taskGr.state = !runRemediation ? -5 : 1;
                taskId = taskGr.insert();
                taskGr.get(taskId);
                notes.forEach(function (note) {
                    var taskGr2 = new GlideRecord("reconcile_duplicate_task");
                    if (taskGr2.get(taskId)) {
                        taskGr2.work_notes = note;
                        taskGr2.update();
                    }
                });
                gs.addInfoMessage(`Created ${CG_RecordUtils.getRecordUrl(taskId, "reconcile_duplicate_task")}`);
            }
            if (JSUtil.nil(taskId))
                throw new Error("Task not found");
            // 
            //updateTaskLog(taskGr, notes, true);
            //if (runRemediation && SNC.RemediationUtil.getRemediationsForTask(taskId, true).length > 0)
            //	processDuplicateTask(taskId);
            return taskId;
        }
        /**
             *
             * @param {GlideRecordLike<"reconcile_duplicate_task">} taskId
             * @param {boolean} [throwErr]
             * @returns {boolean}
             */
        static canProcessTask(taskId, throwErr) {
            try {
                var taskGr = CG_RecordUtils.getRecord(taskId, "reconcile_duplicate_task");
                if (taskGr == null)
                    throw new Error("Task not found");
                if (!taskGr.active && taskGr.state != -5)
                    throw new Error("Task not active");
                //if (SNC.RemediationUtil.getRemediationsForTask(taskId, false).length == 0)
                //    throw makeError("No valid remediations found");
                var dupRemGr = new GlideRecord("cmdb_duplicate_ci_remediation");
                dupRemGr.addQuery("task", taskId);
                dupRemGr.addQuery("state", "MERGING");
                dupRemGr.query();
                if (dupRemGr.next())
                    throw new Error(`Remediation ${CG_RecordUtils.getRecordString(dupRemGr)} currently merging`);
                return true;
            }
            catch (ex) {
                if (throwErr)
                    throw ex;
            }
            return false;
        }
        /**
             *
             * @param {GlideRecord<"reconcile_duplicate_task"> | SysId<"reconcile_duplicate_task">} _taskGr
             * @param {string} work_notes
             * @returns {GlideRecord<"reconcile_duplicate_task">}
             */
        static updateTaskLog(_taskGr, work_notes, noCode) {
            var taskGr = CG_RecordUtils.getRecord(_taskGr, "reconcile_duplicate_task");
            taskGr.get(taskGr.getUniqueValue());
            if (JSUtil.notNil(work_notes)) {
                if (!noCode)
                    work_notes = work_notes.code();
                taskGr.work_notes = work_notes;
                taskGr.get(taskGr.update());
            }
            if (_taskGr instanceof GlideRecord)
                _taskGr = taskGr;
            return taskGr;
        }
        /**
             * @param {SysId<"cmdb_duplicate_ci_remediation">} dupID
             * @returns {SysId<"sys_history_line">[]}
             */
        static getAuditForRemediation(dupID) {
            return new GlideQuery("cmdb_duplicate_ci_remediation")
                .get(dupID, ['sys_created_on', 'sys_updated_on', 'task.number'])
                .map(function (dupGr) {
                    var auditGQ = new GlideQuery("sys_audit")
                        .where("sys_created_on", ">=", dupGr.sys_created_on)
                        .where("sys_created_on", "<=", dupGr.sys_updated_on)
                        .where("reason", `Duplicate Task ${dupGr.task.number} Remediation`);
                    return new GlideQuery("sys_history_line")
                        .where("set", "IN", new GlideQuery(auditGQ.table, auditGQ.plan)
                            .aggregate("count")
                            .groupBy("tablename", "documentkey")
                            .select()
                            .reduce(function (/** @type {SysId<"sys_history_set">[]} */ state, res) {
                                var gr = new GlideRecord(res.group.tablename);
                                if (gr.get(res.group.documentkey))
                                    state.push(new GlideHistorySet(gr).generate());
                                return state;
                            }, []))
                        .where("audit_sysid", "IN", new GlideQuery(auditGQ.table, auditGQ.plan)
                            .select()
                            .reduce(function (/** @type {SysId<"sys_audit">[]} */ state, rec) {
                                state.push(rec.sys_id);
                                return state;
                            }, []))
                        .select()
                        .reduce(function (/** @type {SysId<"sys_history_line">[]} */ state, curr) {
                            state.push(curr.sys_id);
                            return state;
                        }, []);
                })
                .orElse([]);
        }
        /**
             *
             * @param {GlideStringQuery<"reconcile_duplicate_task">} query
             */
        static getAudits(query) {
            if (JSUtil.nil(query))
                return null;
            var histIDs = new GlideQuery('cmdb_duplicate_ci_remediation')
                .where("task", "IN", getSubQuery('reconcile_duplicate_task', "sys_id", query))
                .where("state", "IN", ["COMPLETE", "COMPLETE_WITH_ERROR", "FAILED"])
                .select()
                .reduce(function (/** @type {SysId<"sys_history_line">[]} */ state, rec) {
                    return state.concat(CG_DuplicateUtils.getAuditForRemediation(rec.sys_id));
                }, []);
            var histGr = new GlideRecord("sys_history_line");
            histGr.addQuery("sys_id", "IN", histIDs);
            histGr.orderBy("set.table");
            histGr.orderBy("set.id");
            histGr.orderBy("label");
            histGr.addEncodedQuery("GROUPBYset");
            return histGr;
        }
        /**
             *
             * @param {SysId<"reconcile_duplicate_task">} taskId
             * @returns {SysId<"sys_audit_delete">[]}
             */
        static getDeletedRecords(taskId) {
            var regex = /sys_audit_delete\.do\?sys_id=([a-f0-9]{32})/gm;
            var taskGr = new GlideRecord("reconcile_duplicate_task");
            if (taskGr.get(taskId)) {
                var str = taskGr.work_notes.getJournalEntry(-1);
                /**
                 *
                 * @param {RegExp} regex
                 * @param {string} str
                 * @param {number} index
                 * @returns {string[]}
                 */
                function getMatches(regex, str, index) {
                    index = index || 0;
                    var m;
                    var ret = [];
                    while ((m = regex.exec(str)) !== null) {
                        // This is necessary to avoid infinite loops with zero-width matches
                        if (m.index === regex.lastIndex) {
                            regex.lastIndex++;
                        }
                        // The result can be accessed through the `m`-variable.
                        ret.push(m[index]);
                    }
                    return ret;
                }
                return getMatches(regex, str, 1);
            }
            return [];
        }
        /**
             *
             * @param {SysId<"reconcile_duplicate_task">} taskId
             * @returns
             */
        static getRemediationWorkflows(taskId) {
            return SNC.RemediationUtil.getRemediationsForTask(taskId, null)
                .map(function (curr) {
                    return curr.workflow;
                })
                .unique();
        }
        /**
             *
             * @param {GlideRecord<"reconcile_duplicate_task">} current
             */
        static runRemediation(current) {
            try {
                var workflows = CG_DuplicateUtils.getRemediationWorkflows(current.sys_id);
                if (workflows.length == 1) {
                    new Workflow().startFlow(workflows[0], current, null, null);
                }
            }
            catch (ex) {
                gs.error(`Error running remediations for ${current.getRecordClassName()}:${current.getUniqueValue()}: ${ex}`);
            }
        }
        /**
             * @template {table_name} T
             * @param {SysId<"reconcile_duplicate_task">} taskID
             * @returns {Partial<{ "class": {[P in T]?: T}; "attribute": {[F in field_name<T>]?: ToString<field_value<F, T>>; }>}
             */
        static getDuplicateData(taskID) {
            var gr = new GlideRecord("reconcile_duplicate_task");
            if (gr.get(taskID) && !gr.attributes_blob.nil()) {
                new DuplicateTaskDataPopulator()._populateTaskData(gr.getValue("attributes_blob"), gr.getValue("sys_id"), gr.getValue("sys_domain"));
                // We no longer need the attributes_blob because the data is already denormalized into a separate table
                gr.setValue("attributes_blob", "NULL");
                gr.update();
            }
            try {
                return new GlideQuery("reconcile_duplicate_task_data")
                    .where("task", taskID)
                    .select("category", "key", "value")
                    .reduce(function (state, curr) {
                        if (!state[curr.category])
                            state[curr.category] = {};
                        state[curr.category][curr.key] = curr.value;
                        return state;
                    }, /** @type {{[P in sn_cmdb.DuplicateTemplateCategory]?: {[x: string]: string}}} */ {});
            }
            catch (ex) {
                return {};
            }
        }
        /**
             * @template {table_name} T
             * @param {SysId<"reconcile_duplicate_task">} taskID
             * @returns {boolean};
             * @throws {Error}
             */
        static checkDuplicateTask(taskID) {
            /** @type {SysId<T>[]} */
            var dupIDs = CG_DuplicateUtils.getDuplicateIDsForTask(taskID);
            var data = CG_DuplicateUtils.getDuplicateData(taskID);
            try {
                return Object.keys(data["class"])
                    .map(function (key) {
                        return data["class"][key];
                    })
                    .every(function (/** @type {T} */ table_name) {
                        return dupIDs.every(function (id) {
                            var gr = new GlideRecord(table_name);
                            gr.addQuery("sys_id", id);
                            return Object.keys(data.attribute)
                                .every(function (attr) {
                                    var gr = new GlideRecord(table_name);
                                    gr.addQuery("sys_id", id);
                                    gr.addQuery(attr, data.attribute[attr]);
                                    if (CG_RecordUtils.getQueryCount(gr.getTableName(), gr.getEncodedQuery()) != 1) {
                                        var gr2 = new GlideRecord("reconcile_duplicate_task");
                                        if (gr2.get(taskID)) {
                                            gr2.state = 7;
                                            gr2.work_notes = (`Record {0} does not match field {1}: {2}`).code();
                                            gr2.update();
                                        }
                                        return false;
                                    }
                                    return true;
                                });
                        });
                    });
            }
            catch (ex) {
            }
        }
        /**
             *
             * @param {SysId<"reconcile_duplicate_task">} taskId
             */
        static validateDuplicateTask(taskId) {
            try {
                var dupData = CG_DuplicateUtils.getDuplicateData(taskId);
                var tableName = Object.keys(dupData["class"])[0];
                if (!gs.tableExists(tableName))
                    throw new Error(`table does not exist: ${tableName}`);
                var gr = new GlideRecord(tableName);
                for (var prop in dupData.attribute)
                    gr.addQuery(prop, dupData.attribute[prop]);
                var entryId = dupData.identifier_entry.rule;
                var rule = CG_CMDBIdentifier.getRuleBySysID(entryId);
                if (!!rule && JSUtil.notNil(rule.encodedQuery)) {
                    gr.addEncodedQuery(rule.encodedQuery);
                }
                var depId = undefined;
                var rel_type = undefined;
                if ("relationship" in dupData) {
                    depId = dupData.relationship.depends_on;
                    rel_type = dupData.relationship.rel_type;
                    gr.addEncodedQuery(`RLQUERYcmdb_rel_ci.parent,>=1,m2m^child=${depId}^type=${rel_type}^ENDRLQUERY^ORRLQUERYcmdb_rel_ci.child,>=1,m2m^parent=${depId}^type=${rel_type}^ENDRLQUERY`);
                }
                var taskGr = new GlideRecord("reconcile_duplicate_task");
                taskGr.setForceUpdate(true);
                var ids = getSubQuery(gr.getTableName(), "sys_id", gr.getEncodedQuery());
                if (ids.length > 0) {
                    var grR = new GlideRecord("duplicate_audit_result");
                    grR.addQuery("follow_on_task", taskId);
                    grR.addQuery("duplicate_ci", "NOT IN", ids);
                    grR.deleteMultiple();
                    ids.forEach(function (id) {
                        var grR = new GlideRecord("duplicate_audit_result");
                        grR.addQuery("follow_on_task", taskId);
                        grR.addQuery("duplicate_ci", id);
                        grR.query();
                        if (!grR.next()) {
                            grR.initialize();
                            grR.setValue("table", tableName);
                            grR.setValue("duplicate_ci", id);
                            if (global.JSUtil.notNil(depId)) {
                                grR.setValue("duplicate_id", id + depId);
                                grR.setValue("depend_on", depId);
                                grR.setValue("relationship", rel_type);
                            }
                            else {
                                grR.setValue("duplicate_id", id);
                            }
                            grR.setValue("follow_on_task", taskId);
                            grR.insert();
                        }
                        else {
                            grR.setValue("table", tableName);
                            if (global.JSUtil.notNil(depId)) {
                                grR.setValue("duplicate_id", id + depId);
                                grR.setValue("depend_on", depId);
                                grR.setValue("relationship", rel_type);
                            }
                            else {
                                grR.setValue("duplicate_id", id);
                            }
                            grR.update();
                        }
                    });
                    if (taskGr.get(taskId)) {
                        var dupItems = global.getSubQuery("duplicate_audit_result", "duplicate_ci", `follow_on_task=${taskId}`);
                        if (dupItems.length < 2)
                            taskGr.state = 7;
                        taskGr.update();
                    }
                }
                else {
                    if (taskGr.get(taskId)) {
                        taskGr.state = 7;
                        taskGr.update();
                    }
                }
            }
            catch (ex) {
            }
        }
        /**
             * @param {string} query
             */
        static autoMergeTasks(query) {
            CG_FuncUtils.runAsyncChunk(CG_RecordUtils.decodeQuery(query), 'reconcile_duplicate_task', "CG_DuplicateUtils.runRemediation");
        }
        /**
         *
         * @param {SysId<"cmdb_duplicate_ci_remediation">} dupResID
         */
        process(dupResID) {
            new SNC.CMDBDuplicateMerger().processDuplicateResolution(dupResID);
        }
    }

    return CG_DuplicateUtils;
})();
