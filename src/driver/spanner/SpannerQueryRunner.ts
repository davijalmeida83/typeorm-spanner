import {QueryRunner} from "../../query-runner/QueryRunner";
import {TransactionAlreadyStartedError} from "../../error/TransactionAlreadyStartedError";
import {TransactionNotStartedError} from "../../error/TransactionNotStartedError";
import {TableColumn} from "../../schema-builder/table/TableColumn";
import {Table} from "../../schema-builder/table/Table";
import {TableForeignKey} from "../../schema-builder/table/TableForeignKey";
import {TableIndex} from "../../schema-builder/table/TableIndex";
import {QueryRunnerAlreadyReleasedError} from "../../error/QueryRunnerAlreadyReleasedError";
import {SpannerDriver, SpannerColumnUpdateWithCommitTimestamp} from "./SpannerDriver";
import {SpannerExtendSchemas} from "./SpannerRawTypes";
import {ReadStream} from "../../platform/PlatformTools";
import {RandomGenerator} from "../../util/RandomGenerator";
import {QueryFailedError} from "../../error/QueryFailedError";
import {TableUnique} from "../../schema-builder/table/TableUnique";
import {BaseQueryRunner} from "../../query-runner/BaseQueryRunner";
import {Broadcaster} from "../../subscriber/Broadcaster";
import {PromiseUtils} from "../../index";
import {TableCheck} from "../../schema-builder/table/TableCheck";
import {IsolationLevel} from "../types/IsolationLevel";
import {QueryBuilder} from "../../query-builder/QueryBuilder";
import {ObjectLiteral} from "../../common/ObjectLiteral";


/**
 * Runs queries on a single mysql database connection.
 */
export class SpannerQueryRunner extends BaseQueryRunner implements QueryRunner {

    // -------------------------------------------------------------------------
    // Public Implemented Properties
    // -------------------------------------------------------------------------

    /**
     * Database driver used by connection.
     */
    driver: SpannerDriver;

    // -------------------------------------------------------------------------
    // Protected Properties
    // -------------------------------------------------------------------------

    /**
     * transaction if startsTransaction
     */
    protected tx: any; 


    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(driver: SpannerDriver) {
        super();
        this.driver = driver;
        this.connection = driver.connection;
        this.broadcaster = new Broadcaster(this);
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Creates/uses database connection from the connection pool to perform further operations.
     * Returns obtained database connection.
     */
    connect(): Promise<any> {
        if (!this.databaseConnection) {
            return (async () => {
                this.databaseConnection = await this.driver.getDatabaseHandle();
            })();
        }
        return Promise.resolve(this.databaseConnection);
    }

    /**
     * Releases used database connection.
     * You cannot use query runner methods once its released.
     */
    release(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * Starts transaction on the current connection.
     */
    async startTransaction(isolationLevel?: IsolationLevel): Promise<void> {
        if (this.isTransactionActive)
            throw new TransactionAlreadyStartedError();
            
        this.isTransactionActive = true;
        return this.connect().then(async (db) => {
          // TODO: Specify spanner transaction types
            const txResponse = await this.databaseConnection.getTransaction({
              readOnly: false
                // //readOnly: true,
                // strong: !!isolationLevel
            });

            this.tx = txResponse[0]
        });
    }

    /**
     * Commits transaction.
     * Error will be thrown if transaction was not started.
     */
    async commitTransaction(): Promise<void> {
      // console.log('SpannerQueryRunner.commitTransaction')
        if (!this.isTransactionActive)
            throw new TransactionNotStartedError();
            
        await new Promise((res, rej) => this.tx.commit((err: Error) => {
            if (err) { rej(err); }
            else { 
                this.tx = null;
                this.isTransactionActive = false;
                res(); 
            }
        }));
    }

    /**
     * Rollbacks transaction.
     * Error will be thrown if transaction was not started.
     */
    async rollbackTransaction(): Promise<void> {
      // console.log('SpannerQueryRunner.rollbackTransaction')
        if (!this.isTransactionActive)
            throw new TransactionNotStartedError();

        await new Promise((res, rej) => this.tx.rollback((err: Error) => {
            if (err) { rej(err); }
            else { 
                this.tx = null;
                this.isTransactionActive = false;
                res(); 
            }
        }));
    }

    /**
     * Executes a raw SQL query.
     */
    query(query: string, parameters?: any[]): Promise<any> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        // handle administrative queries.
        let m: RegExpMatchArray | null;
        
        if ((m = query.match(/^\s*(CREATE|DROP|ALTER)\s+(.+)/s))) {
            const statements = query
              .split(';')
              .map(statement => statement.trim())
              .filter(statement => !!statement)

            this.driver.connection.logger.logQuery(query, parameters, this);

            return this.simpleHandleAdministrativeQuery(statements)
        } else if (!query.match(/^\s*SELECT\s+(.+)/)) {
            throw new Error(`the query cannot handle by this function: ${query}`);
        }

        return new Promise(async (ok, fail) => {
            try {
                await this.connect();
                const db = this.databaseConnection;
                // const [params, types] = this.generateQueryParameterAndTypes(parameters);
                const params = this.generateQueryParameters(parameters)
                
                // const params = { id: 'b993f470-eb84-472b-a34e-96c0d564d563'}
                // const types = {}

                // console.log('======================================================================')
                // console.log('SpannerQueryRunner.query')
                // console.log(query)
                // console.log(params)
                // query = 'SELECT `User`.`id` AS `User_id`, `User`.`firstName` AS `User_firstName`, `User`.`lastName` AS `User_lastName`, `User`.`age` AS `User_age` FROM `user` `User` WHERE (`User`.`id` IN (@id))'
                // console.log(query)
                // console.log('======================================================================')

                this.driver.connection.logger.logQuery(query, parameters, this);
                const queryStartTime = +new Date();
                db.run({sql: query, params, types: {}, json: true}, (err: any, result: any) => {


                    // log slow queries if maxQueryExecution time is set
                    const maxQueryExecutionTime = this.driver.connection.options.maxQueryExecutionTime;
                    const queryEndTime = +new Date();
                    const queryExecutionTime = queryEndTime - queryStartTime;
                    if (maxQueryExecutionTime && queryExecutionTime > maxQueryExecutionTime)
                        this.driver.connection.logger.logQuerySlow(queryExecutionTime, query, parameters, this);

                    if (err) {
                        this.driver.connection.logger.logQueryError(err, query, parameters, this);
                        return fail(new QueryFailedError(query, parameters, err));
                    }

                    // console.log('========================================================================')
                    // console.log('SpannerQueryRunner.query RESULT')
                    // console.log(JSON.stringify(result, null, 2))
                    // console.log('========================================================================')

                    ok(result);
                });

            } catch (err) {
                fail(err);
            }
        });
    }

    /**
     * execute query. call from XXXQueryBuilder
     */
    queryByBuilder<Entity>(qb: QueryBuilder<Entity>): Promise<any> {
      // console.log('======================================================================')
      // console.log('SpannerQueryRunner.queryByRunner')
      // console.log('qb.expressionMap.queryType', qb.expressionMap.queryType)
      // console.log('======================================================================')
        const fmaps: { [key:string]:(qb:QueryBuilder<Entity>) => Promise<any>} = {
            select: this.select,
            insert: this.insert, 
            update: this.update,
            delete: this.delete
        };
        
        return fmaps[qb.expressionMap.queryType].call(this, qb);
    }

    /**
     * Returns raw data stream.
     */
    stream(query: string, parameters?: any[], onEnd?: Function, onError?: Function): Promise<ReadStream> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        return new Promise(async (ok, fail) => {
            try {
                await this.connect();
                const db = this.databaseConnection;
                const [params, types] = this.generateQueryParameterAndTypes(parameters);
                this.driver.connection.logger.logQuery(query, parameters, this);
                const stream = db.runStream({sql: query, params, types});
                if (onEnd) stream.on("end", onEnd);
                if (onError) stream.on("error", onError);
                ok(stream);

            } catch (err) {
                fail(err);
            }
        });
    }

    /**
     * Returns all available database names including system databases.
     */
    async getDatabases(): Promise<string[]> {
        return this.driver.getDatabases();
    }

    /**
     * Returns all available schema names including system schemas.
     * If database parameter specified, returns schemas of that database.
     */
    async getSchemas(database?: string): Promise<string[]> {
        throw new Error(`NYI: spanner: getSchemas`);
    }

    /**
     * Checks if database with the given name exist.
     */
    async hasDatabase(database: string): Promise<boolean> {
        return this.connect().then(async () => {
            const dbs = await this.driver.getDatabases();
            return dbs.indexOf(database) >= 0;
        });
    }

    /**
     * Checks if schema with the given name exist.
     */
    async hasSchema(schema: string): Promise<boolean> {
        throw new Error(`NYI: spanner: hasSchema`);
    }

    /**
     * Checks if table with the given name exist in the database.
     */
    async hasTable(tableOrName: Table|string): Promise<boolean> {
        return this.connect().then(async () => {
            const table = await this.driver.loadTables(tableOrName);
            return !!table[0];
        });
    }

    /**
     * Checks if column with the given name exist in the given table.
     */
    async hasColumn(tableOrName: Table|string, column: TableColumn|string): Promise<boolean> {
        return this.connect().then(async () => {
            const tables = await this.driver.loadTables(tableOrName);
            return !!tables[0].columns.find((c: TableColumn) => {
                if (typeof column === 'string' && c.name == column) {
                    return true;
                } else if (column instanceof TableColumn && c.name == column.name) {
                    return true;
                }
                return false;
            });
        });
    }

    /**
     * Creates a new database.
     */
    async createDatabase(database: string, ifNotExist?: boolean): Promise<void> {
        const up = ifNotExist ? `CREATE DATABASE IF NOT EXISTS \`${database}\`` : `CREATE DATABASE \`${database}\``;
        const down = `DROP DATABASE \`${database}\``;
        await this.executeQueries(up, down);
    }

    /**
     * Drops database.
     */
    async dropDatabase(database: string, ifExist?: boolean): Promise<void> {
        const up = ifExist ? `DROP DATABASE IF EXISTS \`${database}\`` : `DROP DATABASE \`${database}\``;
        const down = `CREATE DATABASE \`${database}\``;
        await this.executeQueries(up, down);
    }

    /**
     * Creates a new table schema.
     */
    async createSchema(schema: string, ifNotExist?: boolean): Promise<void> {
        throw new Error(`NYI: spanner: createSchema`);
    }

    /**
     * Drops table schema.
     */
    async dropSchema(schemaPath: string, ifExist?: boolean): Promise<void> {
        throw new Error(`NYI: spanner: dropSchema`);
    }

    /**
     * Creates a new table. aka 'schema' on spanner
     */
    async createTable(table: Table, ifNotExist: boolean = false, createForeignKeys: boolean = true): Promise<void> {
        if (ifNotExist) {
            const isTableExist = await this.hasTable(table);
            if (isTableExist) return Promise.resolve();
        }
        const upQueries: string[] = [];
        const downQueries: string[] = [];

        // console.log('createTable name=', table.name);
        upQueries.push(this.createTableSql(table, createForeignKeys));
        downQueries.push(this.dropTableSql(table));

        // we must first drop indices, than drop foreign keys, because drop queries runs in reversed order
        // and foreign keys will be dropped first as indices. This order is very important, because we can't drop index
        // if it related to the foreign key.

        // createTable does not need separate method to create indices, because it create indices in the same query with table creation.
        table.indices.forEach(index => downQueries.push(this.dropIndexSql(table, index)));

        // if createForeignKeys is true, we must drop created foreign keys in down query.
        // createTable does not need separate method to create foreign keys, because it create fk's in the same query with table creation.
        if (createForeignKeys)
            table.foreignKeys.forEach(foreignKey => downQueries.push(this.dropForeignKeySql(table, foreignKey)));

        await this.executeQueries(upQueries, downQueries);

        if (!this.driver.isSchemaTable(table)) {
            // if table creation success, sync schema table
            await Promise.all(table.columns.map(c => { return this.syncExtendSchema(table, c) }));
        }

        // set table to driver
        this.driver.setTable(table);

    }

    /**
     * Drop the table.
     */
    async dropTable(target: Table|string, ifExist?: boolean, dropForeignKeys: boolean = true): Promise<void> {
        // It needs because if table does not exist and dropForeignKeys or dropIndices is true, we don't need
        // to perform drop queries for foreign keys and indices.
        if (ifExist) {
            const isTableExist = await this.hasTable(target);
            if (!isTableExist) return Promise.resolve();
        }

        // if dropTable called with dropForeignKeys = true, we must create foreign keys in down query.
        const createForeignKeys: boolean = dropForeignKeys;
        const tableName = target instanceof Table ? target.name : target;
        const table = await this.getCachedTable(tableName);
        const upQueries: string[] = [];
        const downQueries: string[] = [];

        if (dropForeignKeys)
            table.foreignKeys.forEach(foreignKey => upQueries.push(this.dropForeignKeySql(table, foreignKey)));

        table.indices.forEach(index => upQueries.push(this.dropIndexSql(table, index)));

        upQueries.push(this.dropTableSql(table));
        downQueries.push(this.createTableSql(table, createForeignKeys));

        await this.executeQueries(upQueries, downQueries);
    }

    /**
     * Renames a table.
     */
    async renameTable(oldTableOrName: Table|string, newTableName: string): Promise<void> {
        // TODO: re-create table
        throw new Error(`NYI: spanner: renameTable`);

        /*const upQueries: string[] = [];
        const downQueries: string[] = [];
        const oldTable = oldTableOrName instanceof Table ? oldTableOrName : await this.getCachedTable(oldTableOrName);
        const newTable = oldTable.clone();
        const dbName = oldTable.name.indexOf(".") === -1 ? undefined : oldTable.name.split(".")[0];
        newTable.name = dbName ? `${dbName}.${newTableName}` : newTableName;

        // rename table
        upQueries.push(`RENAME TABLE ${this.escapeTableName(oldTable.name)} TO ${this.escapeTableName(newTable.name)}`);
        downQueries.push(`RENAME TABLE ${this.escapeTableName(newTable.name)} TO ${this.escapeTableName(oldTable.name)}`);

        // rename index constraints
        newTable.indices.forEach(index => {
            // build new constraint name
            const columnNames = index.columnNames.map(column => `\`${column}\``).join(", ");
            const newIndexName = this.connection.namingStrategy.indexName(newTable, index.columnNames, index.where);

            // build queries
            let indexType = "";
            if (index.isUnique)
                indexType += "UNIQUE ";
            if (index.isSpatial)
                indexType += "SPATIAL ";
            if (index.isFulltext)
                indexType += "FULLTEXT ";
            upQueries.push(`ALTER TABLE ${this.escapeTableName(newTable)} DROP INDEX \`${index.name}\`, ADD ${indexType}INDEX \`${newIndexName}\` (${columnNames})`);
            downQueries.push(`ALTER TABLE ${this.escapeTableName(newTable)} DROP INDEX \`${newIndexName}\`, ADD ${indexType}INDEX \`${index.name}\` (${columnNames})`);

            // replace constraint name
            index.name = newIndexName;
        });

        // rename foreign key constraint
        newTable.foreignKeys.forEach(foreignKey => {
            // build new constraint name
            const columnNames = foreignKey.columnNames.map(column => `\`${column}\``).join(", ");
            const referencedColumnNames = foreignKey.referencedColumnNames.map(column => `\`${column}\``).join(",");
            const newForeignKeyName = this.connection.namingStrategy.foreignKeyName(newTable, foreignKey.columnNames);

            // build queries
            let up = `ALTER TABLE ${this.escapeTableName(newTable)} DROP FOREIGN KEY \`${foreignKey.name}\`, ADD CONSTRAINT \`${newForeignKeyName}\` FOREIGN KEY (${columnNames}) ` +
                `REFERENCES ${this.escapeTableName(foreignKey.referencedTableName)}(${referencedColumnNames})`;
            if (foreignKey.onDelete)
                up += ` ON DELETE ${foreignKey.onDelete}`;
            if (foreignKey.onUpdate)
                up += ` ON UPDATE ${foreignKey.onUpdate}`;

            let down = `ALTER TABLE ${this.escapeTableName(newTable)} DROP FOREIGN KEY \`${newForeignKeyName}\`, ADD CONSTRAINT \`${foreignKey.name}\` FOREIGN KEY (${columnNames}) ` +
                `REFERENCES ${this.escapeTableName(foreignKey.referencedTableName)}(${referencedColumnNames})`;
            if (foreignKey.onDelete)
                down += ` ON DELETE ${foreignKey.onDelete}`;
            if (foreignKey.onUpdate)
                down += ` ON UPDATE ${foreignKey.onUpdate}`;

            upQueries.push(up);
            downQueries.push(down);

            // replace constraint name
            foreignKey.name = newForeignKeyName;
        });

        await this.executeQueries(upQueries, downQueries);

        // rename old table and replace it in cached tabled;
        oldTable.name = newTable.name;
        this.replaceCachedTable(oldTable, newTable);*/
    }

    /**
     * Creates a new column from the column in the table.
     */
    async addColumn(tableOrName: Table|string, column: TableColumn): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const clonedTable = table.clone();
        const upQueries: string[] = [];
        const downQueries: string[] = [];
        const skipColumnLevelPrimary = clonedTable.primaryColumns.length > 0;

        upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD ${this.buildCreateColumnSql(column, skipColumnLevelPrimary, false)}`);
        downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP COLUMN \`${column.name}\``);

        // create or update primary key constraint
        if (column.isPrimary) {
            // TODO: re-create table
            throw new Error(`NYI: spanner: addColumn column.isPrimary`);
            /*
            // if we already have generated column, we must temporary drop AUTO_INCREMENT property.
            const generatedColumn = clonedTable.columns.find(column => column.isGenerated && column.generationStrategy === "increment");
            if (generatedColumn) {
                const nonGeneratedColumn = generatedColumn.clone();
                nonGeneratedColumn.isGenerated = false;
                nonGeneratedColumn.generationStrategy = undefined;
                upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${column.name}\` ${this.buildCreateColumnSql(nonGeneratedColumn, true)}`);
                downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${nonGeneratedColumn.name}\` ${this.buildCreateColumnSql(column, true)}`);
            }

            const primaryColumns = clonedTable.primaryColumns;
            let columnNames = primaryColumns.map(column => `\`${column.name}\``).join(", ");
            upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP PRIMARY KEY`);
            downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD PRIMARY KEY (${columnNames})`);

            primaryColumns.push(column);
            columnNames = primaryColumns.map(column => `\`${column.name}\``).join(", ");
            upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD PRIMARY KEY (${columnNames})`);
            downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP PRIMARY KEY`);

            // if we previously dropped AUTO_INCREMENT property, we must bring it back
            if (generatedColumn) {
                const nonGeneratedColumn = generatedColumn.clone();
                nonGeneratedColumn.isGenerated = false;
                nonGeneratedColumn.generationStrategy = undefined;
                upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${nonGeneratedColumn.name}\` ${this.buildCreateColumnSql(column, true)}`);
                downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${column.name}\` ${this.buildCreateColumnSql(nonGeneratedColumn, true)}`);
            }
            */
        }

        // create column index
        const columnIndex = clonedTable.indices.find(index => index.columnNames.length === 1 && index.columnNames[0] === column.name);
        if (columnIndex) {
            upQueries.push(this.createIndexSql(table, columnIndex));
            downQueries.push(this.dropIndexSql(table, columnIndex));

        } else if (column.isUnique) {
            const uniqueIndex = new TableIndex({
                name: this.connection.namingStrategy.indexName(table.name, [column.name]),
                columnNames: [column.name],
                isUnique: true
            });
            clonedTable.indices.push(uniqueIndex);
            clonedTable.uniques.push(new TableUnique({
                name: uniqueIndex.name,
                columnNames: uniqueIndex.columnNames
            }));
            upQueries.push(this.createIndexSql(table, uniqueIndex));
            downQueries.push(this.dropIndexSql(table, uniqueIndex));
        }

        await this.executeQueries(upQueries, downQueries);
        await this.syncExtendSchema(table, column);

        clonedTable.addColumn(column);
        this.replaceCachedTable(table, clonedTable);
    }

    /**
     * Creates a new columns from the column in the table.
     */
    async addColumns(tableOrName: Table|string, columns: TableColumn[]): Promise<void> {
        await PromiseUtils.runInSequence(columns, column => this.addColumn(tableOrName, column));
    }

    /**
     * Renames column in the given table.
     */
    async renameColumn(tableOrName: Table|string, oldTableColumnOrName: TableColumn|string, newTableColumnOrName: TableColumn|string): Promise<void> {
        throw new Error(`NYI: spanner: renameColumn`);
        /*
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const oldColumn = oldTableColumnOrName instanceof TableColumn ? oldTableColumnOrName : table.columns.find(c => c.name === oldTableColumnOrName);
        if (!oldColumn)
            throw new Error(`Column "${oldTableColumnOrName}" was not found in the "${table.name}" table.`);

        let newColumn: TableColumn|undefined = undefined;
        if (newTableColumnOrName instanceof TableColumn) {
            newColumn = newTableColumnOrName;
        } else {
            newColumn = oldColumn.clone();
            newColumn.name = newTableColumnOrName;
        }

        await this.changeColumn(table, oldColumn, newColumn);
        */
    }

    /**
     * Changes a column in the table.
     * according to https://cloud.google.com/spanner/docs/schema-updates, only below are allowed
     * - Change a STRING column to a BYTES column or a BYTES column to a STRING column.
     * - Increase or decrease the length limit for a STRING or BYTES type (including to MAX), unless it is a primary key column inherited by one or more child tables.
     * - Add/Remove NOT NULL constraint for non-key column
     * - Enable or disable commit timestamps in value and primary key columns.
     */
    async changeColumn(tableOrName: Table|string, oldColumnOrName: TableColumn|string, newColumn: TableColumn): Promise<void> {
        //TODO: implement above changes in comment

        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        let clonedTable = table.clone();
        const upQueries: string[] = [];
        const downQueries: string[] = [];

        const oldColumn = oldColumnOrName instanceof TableColumn
            ? oldColumnOrName
            : table.columns.find(column => column.name === oldColumnOrName);
        if (!oldColumn)
            throw new Error(`Column "${oldColumnOrName}" was not found in the "${table.name}" table.`);

        if (oldColumn.name !== newColumn.name) {
            throw new Error(`NYI: spanner: changeColumn: change column name ${oldColumn.name} => ${newColumn.name}`);
        }

        if (oldColumn.type !== newColumn.type) {
            // - Change a STRING column to a BYTES column or a BYTES column to a STRING column.
            if (!(oldColumn.type === "string" && newColumn.type === "bytes") &&
                !(oldColumn.type === "bytes" && newColumn.type === "string")) {
                throw new Error(`NYI: spanner: changeColumn: change column type ${oldColumn.type} => ${newColumn.type}`);
            }
        }

        if (oldColumn.length && newColumn.length && (oldColumn.length !== newColumn.length)) {
            // - Increase or decrease the length limit for a STRING or BYTES type (including to MAX)
            if (!(oldColumn.type === "string" && newColumn.type === "bytes") &&
                !(oldColumn.type === "bytes" && newColumn.type === "string")) {
                throw new Error(`NYI: spanner: changeColumn: change column type ${oldColumn.type} => ${newColumn.type}`);
            }
            // TODO: implement following check.
            // `unless it is a primary key column inherited by one or more child tables.`
        }

        if (oldColumn.isNullable !== newColumn.isNullable) {
            // - Add/Remove NOT NULL constraint for non-key column
            if (clonedTable.indices.find(index => {
                return index.columnNames.length === 1 && index.columnNames[0] === newColumn.name;
            })) {
                throw new Error(`NYI: spanner: changeColumn: change nullable for ${oldColumn.name}, which is indexed`);
            }
        }

        // - Enable or disable commit timestamps in value and primary key columns.
        if (oldColumn.default !== newColumn.default) {
            if (newColumn.default !== SpannerColumnUpdateWithCommitTimestamp &&
                oldColumn.default !== SpannerColumnUpdateWithCommitTimestamp) {
                throw new Error(`NYI: spanner: changeColumn: set default ${oldColumn.default} => ${newColumn.default}`);

            }
        }

        // any other invalid changes
        if (oldColumn.isPrimary !== newColumn.isPrimary ||
            oldColumn.asExpression !== newColumn.asExpression ||
            oldColumn.charset !== newColumn.charset || 
            oldColumn.collation !== newColumn.collation ||
            //oldColumn.comment !== newColumn.comment ||
            // default is managed by schemas table. 
            oldColumn.enum !== newColumn.enum ||
            oldColumn.generatedType !== newColumn.generatedType ||
            // generationStorategy is managed by schemas table
            oldColumn.isArray !== newColumn.isArray
            // isGenerated is managed by schemas table
        ) {
            throw new Error(`NYI: spanner: changeColumn: not supported change ${JSON.stringify(oldColumn)} => ${JSON.stringify(newColumn)}`);
        }

        // if actually changed, store SQLs
        if (this.isColumnChanged(oldColumn, newColumn, true)) {
            upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ALTER COLUMN \`${oldColumn.name}\` ${this.buildCreateColumnSql(newColumn, true)}`);
            downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ALTER COLUMN \`${newColumn.name}\` ${this.buildCreateColumnSql(oldColumn, true)}`);
        }

        await this.executeQueries(upQueries, downQueries);
        await this.syncExtendSchema(table, newColumn);
        this.replaceCachedTable(table, clonedTable);


        /*
        if ((newColumn.isGenerated !== oldColumn.isGenerated && newColumn.generationStrategy !== "uuid")
            || oldColumn.type !== newColumn.type
            || oldColumn.length !== newColumn.length
            || oldColumn.generatedType !== newColumn.generatedType) {
            await this.dropColumn(table, oldColumn);
            await this.addColumn(table, newColumn);

            // update cloned table
            clonedTable = table.clone();

        } else {
            if (newColumn.name !== oldColumn.name) {
                // We don't change any column properties, just rename it.
                upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${oldColumn.name}\` \`${newColumn.name}\` ${this.buildCreateColumnSql(oldColumn, true, true)}`);
                downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${newColumn.name}\` \`${oldColumn.name}\` ${this.buildCreateColumnSql(oldColumn, true, true)}`);

                // rename index constraints
                clonedTable.findColumnIndices(oldColumn).forEach(index => {
                    // build new constraint name
                    index.columnNames.splice(index.columnNames.indexOf(oldColumn.name), 1);
                    index.columnNames.push(newColumn.name);
                    const columnNames = index.columnNames.map(column => `\`${column}\``).join(", ");
                    const newIndexName = this.connection.namingStrategy.indexName(clonedTable, index.columnNames, index.where);

                    // build queries
                    let indexType = "";
                    if (index.isUnique)
                        indexType += "UNIQUE ";
                    if (index.isSpatial)
                        indexType += "SPATIAL ";
                    if (index.isFulltext)
                        indexType += "FULLTEXT ";
                    upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP INDEX \`${index.name}\`, ADD ${indexType}INDEX \`${newIndexName}\` (${columnNames})`);
                    downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP INDEX \`${newIndexName}\`, ADD ${indexType}INDEX \`${index.name}\` (${columnNames})`);

                    // replace constraint name
                    index.name = newIndexName;
                });

                // rename foreign key constraints
                clonedTable.findColumnForeignKeys(oldColumn).forEach(foreignKey => {
                    // build new constraint name
                    foreignKey.columnNames.splice(foreignKey.columnNames.indexOf(oldColumn.name), 1);
                    foreignKey.columnNames.push(newColumn.name);
                    const columnNames = foreignKey.columnNames.map(column => `\`${column}\``).join(", ");
                    const referencedColumnNames = foreignKey.referencedColumnNames.map(column => `\`${column}\``).join(",");
                    const newForeignKeyName = this.connection.namingStrategy.foreignKeyName(clonedTable, foreignKey.columnNames);

                    // build queries
                    let up = `ALTER TABLE ${this.escapeTableName(table)} DROP FOREIGN KEY \`${foreignKey.name}\`, ADD CONSTRAINT \`${newForeignKeyName}\` FOREIGN KEY (${columnNames}) ` +
                        `REFERENCES ${this.escapeTableName(foreignKey.referencedTableName)}(${referencedColumnNames})`;
                    if (foreignKey.onDelete)
                        up += ` ON DELETE ${foreignKey.onDelete}`;
                    if (foreignKey.onUpdate)
                        up += ` ON UPDATE ${foreignKey.onUpdate}`;

                    let down = `ALTER TABLE ${this.escapeTableName(table)} DROP FOREIGN KEY \`${newForeignKeyName}\`, ADD CONSTRAINT \`${foreignKey.name}\` FOREIGN KEY (${columnNames}) ` +
                        `REFERENCES ${this.escapeTableName(foreignKey.referencedTableName)}(${referencedColumnNames})`;
                    if (foreignKey.onDelete)
                        down += ` ON DELETE ${foreignKey.onDelete}`;
                    if (foreignKey.onUpdate)
                        down += ` ON UPDATE ${foreignKey.onUpdate}`;

                    upQueries.push(up);
                    downQueries.push(down);

                    // replace constraint name
                    foreignKey.name = newForeignKeyName;
                });

                // rename old column in the Table object
                const oldTableColumn = clonedTable.columns.find(column => column.name === oldColumn.name);
                clonedTable.columns[clonedTable.columns.indexOf(oldTableColumn!)].name = newColumn.name;
                oldColumn.name = newColumn.name;
            }

            if (this.isColumnChanged(oldColumn, newColumn, true)) {
                upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${oldColumn.name}\` ${this.buildCreateColumnSql(newColumn, true)}`);
                downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${newColumn.name}\` ${this.buildCreateColumnSql(oldColumn, true)}`);
            }

            if (newColumn.isPrimary !== oldColumn.isPrimary) {
                // if table have generated column, we must drop AUTO_INCREMENT before changing primary constraints.
                const generatedColumn = clonedTable.columns.find(column => column.isGenerated && column.generationStrategy === "increment");
                if (generatedColumn) {
                    const nonGeneratedColumn = generatedColumn.clone();
                    nonGeneratedColumn.isGenerated = false;
                    nonGeneratedColumn.generationStrategy = undefined;

                    upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${generatedColumn.name}\` ${this.buildCreateColumnSql(nonGeneratedColumn, true)}`);
                    downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${nonGeneratedColumn.name}\` ${this.buildCreateColumnSql(generatedColumn, true)}`);
                }

                const primaryColumns = clonedTable.primaryColumns;

                // if primary column state changed, we must always drop existed constraint.
                if (primaryColumns.length > 0) {
                    const columnNames = primaryColumns.map(column => `\`${column.name}\``).join(", ");
                    upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP PRIMARY KEY`);
                    downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD PRIMARY KEY (${columnNames})`);
                }

                if (newColumn.isPrimary === true) {
                    primaryColumns.push(newColumn);
                    // update column in table
                    const column = clonedTable.columns.find(column => column.name === newColumn.name);
                    column!.isPrimary = true;
                    const columnNames = primaryColumns.map(column => `\`${column.name}\``).join(", ");
                    upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD PRIMARY KEY (${columnNames})`);
                    downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP PRIMARY KEY`);

                } else {
                    const primaryColumn = primaryColumns.find(c => c.name === newColumn.name);
                    primaryColumns.splice(primaryColumns.indexOf(primaryColumn!), 1);
                    // update column in table
                    const column = clonedTable.columns.find(column => column.name === newColumn.name);
                    column!.isPrimary = false;

                    // if we have another primary keys, we must recreate constraint.
                    if (primaryColumns.length > 0) {
                        const columnNames = primaryColumns.map(column => `\`${column.name}\``).join(", ");
                        upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD PRIMARY KEY (${columnNames})`);
                        downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP PRIMARY KEY`);
                    }
                }

                // if we have generated column, and we dropped AUTO_INCREMENT property before, we must bring it back
                if (generatedColumn) {
                    const nonGeneratedColumn = generatedColumn.clone();
                    nonGeneratedColumn.isGenerated = false;
                    nonGeneratedColumn.generationStrategy = undefined;

                    upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${nonGeneratedColumn.name}\` ${this.buildCreateColumnSql(generatedColumn, true)}`);
                    downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${generatedColumn.name}\` ${this.buildCreateColumnSql(nonGeneratedColumn, true)}`);
                }
            }

            if (newColumn.isUnique !== oldColumn.isUnique) {
                if (newColumn.isUnique === true) {
                    const uniqueIndex = new TableIndex({
                        name: this.connection.namingStrategy.indexName(table.name, [newColumn.name]),
                        columnNames: [newColumn.name],
                        isUnique: true
                    });
                    clonedTable.indices.push(uniqueIndex);
                    clonedTable.uniques.push(new TableUnique({
                        name: uniqueIndex.name,
                        columnNames: uniqueIndex.columnNames
                    }));
                    upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD UNIQUE INDEX \`${uniqueIndex.name}\` (\`${newColumn.name}\`)`);
                    downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP INDEX \`${uniqueIndex.name}\``);

                } else {
                    const uniqueIndex = clonedTable.indices.find(index => {
                        return index.columnNames.length === 1 && index.isUnique === true && !!index.columnNames.find(columnName => columnName === newColumn.name);
                    });
                    clonedTable.indices.splice(clonedTable.indices.indexOf(uniqueIndex!), 1);

                    const tableUnique = clonedTable.uniques.find(unique => unique.name === uniqueIndex!.name);
                    clonedTable.uniques.splice(clonedTable.uniques.indexOf(tableUnique!), 1);

                    upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP INDEX \`${uniqueIndex!.name}\``);
                    downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD UNIQUE INDEX \`${uniqueIndex!.name}\` (\`${newColumn.name}\`)`);
                }
            }
        } */

        // await this.executeQueries(upQueries, downQueries);
        // this.replaceCachedTable(table, clonedTable);
    }

    /**
     * Changes a column in the table.
     */
    async changeColumns(tableOrName: Table|string, changedColumns: { newColumn: TableColumn, oldColumn: TableColumn }[]): Promise<void> {
        await PromiseUtils.runInSequence(changedColumns, changedColumn => this.changeColumn(tableOrName, changedColumn.oldColumn, changedColumn.newColumn));
    }

    /**
     * Drops column in the table.
     */
    async dropColumn(tableOrName: Table|string, columnOrName: TableColumn|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const column = columnOrName instanceof TableColumn ? columnOrName : table.findColumnByName(columnOrName);
        if (!column)
            throw new Error(`Column "${columnOrName}" was not found in table "${table.name}"`);

        const clonedTable = table.clone();
        const upQueries: string[] = [];
        const downQueries: string[] = [];

        // drop primary key constraint
        if (column.isPrimary) {
            throw new Error(`NYI: spanner: dropColumn column.isPrimary`);
            /*
            // if table have generated column, we must drop AUTO_INCREMENT before changing primary constraints.
            const generatedColumn = clonedTable.columns.find(column => column.isGenerated && column.generationStrategy === "increment");
            if (generatedColumn) {
                const nonGeneratedColumn = generatedColumn.clone();
                nonGeneratedColumn.isGenerated = false;
                nonGeneratedColumn.generationStrategy = undefined;

                upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${generatedColumn.name}\` ${this.buildCreateColumnSql(nonGeneratedColumn, true)}`);
                downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${nonGeneratedColumn.name}\` ${this.buildCreateColumnSql(generatedColumn, true)}`);
            }

            // dropping primary key constraint
            const columnNames = clonedTable.primaryColumns.map(primaryColumn => `\`${primaryColumn.name}\``).join(", ");
            upQueries.push(`ALTER TABLE ${this.escapeTableName(clonedTable)} DROP PRIMARY KEY`);
            downQueries.push(`ALTER TABLE ${this.escapeTableName(clonedTable)} ADD PRIMARY KEY (${columnNames})`);

            // update column in table
            const tableColumn = clonedTable.findColumnByName(column.name);
            tableColumn!.isPrimary = false;

            // if primary key have multiple columns, we must recreate it without dropped column
            if (clonedTable.primaryColumns.length > 0) {
                const columnNames = clonedTable.primaryColumns.map(primaryColumn => `\`${primaryColumn.name}\``).join(", ");
                upQueries.push(`ALTER TABLE ${this.escapeTableName(clonedTable)} ADD PRIMARY KEY (${columnNames})`);
                downQueries.push(`ALTER TABLE ${this.escapeTableName(clonedTable)} DROP PRIMARY KEY`);
            }

            // if we have generated column, and we dropped AUTO_INCREMENT property before, and this column is not current dropping column, we must bring it back
            if (generatedColumn && generatedColumn.name !== column.name) {
                const nonGeneratedColumn = generatedColumn.clone();
                nonGeneratedColumn.isGenerated = false;
                nonGeneratedColumn.generationStrategy = undefined;

                upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${nonGeneratedColumn.name}\` ${this.buildCreateColumnSql(generatedColumn, true)}`);
                downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${generatedColumn.name}\` ${this.buildCreateColumnSql(nonGeneratedColumn, true)}`);
            }
            */
        }

        // drop column index
        const columnIndex = clonedTable.indices.find(index => index.columnNames.length === 1 && index.columnNames[0] === column.name);
        if (columnIndex) {
            clonedTable.indices.splice(clonedTable.indices.indexOf(columnIndex), 1);
            upQueries.push(this.dropIndexSql(table, columnIndex));
            downQueries.push(this.createIndexSql(table, columnIndex));

        } else if (column.isUnique) {
            // we splice constraints both from table uniques and indices.
            const uniqueName = this.connection.namingStrategy.uniqueConstraintName(table.name, [column.name]);
            const foundUnique = clonedTable.uniques.find(unique => unique.name === uniqueName);
            if (foundUnique)
                clonedTable.uniques.splice(clonedTable.uniques.indexOf(foundUnique), 1);

            const indexName = this.connection.namingStrategy.indexName(table.name, [column.name]);
            const foundIndex = clonedTable.indices.find(index => index.name === indexName);
            if (foundIndex) {
                clonedTable.indices.splice(clonedTable.indices.indexOf(foundIndex), 1);
                upQueries.push(this.dropIndexSql(table, foundIndex));
                downQueries.push(this.createIndexSql(table, foundIndex));
            }
        }

        upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP COLUMN \`${column.name}\``);
        downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD ${this.buildCreateColumnSql(column, true)}`);

        await this.executeQueries(upQueries, downQueries);
        await this.syncExtendSchema(table, column, true);

        clonedTable.removeColumn(column);
        this.replaceCachedTable(table, clonedTable);
    }

    /**
     * Drops the columns in the table.
     */
    async dropColumns(tableOrName: Table|string, columns: TableColumn[]): Promise<void> {
        await PromiseUtils.runInSequence(columns, column => this.dropColumn(tableOrName, column));
    }

    /**
     * Creates a new primary key.
     */
    async createPrimaryKey(tableOrName: Table|string, columnNames: string[]): Promise<void> {
        throw new Error(`NYI: spanner: createPrimaryKey`);

        /*
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const clonedTable = table.clone();

        const up = this.createPrimaryKeySql(table, columnNames);
        const down = this.dropPrimaryKeySql(table);

        await this.executeQueries(up, down);
        clonedTable.columns.forEach(column => {
            if (columnNames.find(columnName => columnName === column.name))
                column.isPrimary = true;
        });
        this.replaceCachedTable(table, clonedTable);
        */
    }

    /**
     * Updates composite primary keys.
     */
    async updatePrimaryKeys(tableOrName: Table|string, columns: TableColumn[]): Promise<void> {
        throw new Error(`NYI: spanner: updatePrimaryKeys`);
        /*
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const clonedTable = table.clone();
        const columnNames = columns.map(column => column.name);
        const upQueries: string[] = [];
        const downQueries: string[] = [];

        // if table have generated column, we must drop AUTO_INCREMENT before changing primary constraints.
        const generatedColumn = clonedTable.columns.find(column => column.isGenerated && column.generationStrategy === "increment");
        if (generatedColumn) {
            const nonGeneratedColumn = generatedColumn.clone();
            nonGeneratedColumn.isGenerated = false;
            nonGeneratedColumn.generationStrategy = undefined;

            upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${generatedColumn.name}\` ${this.buildCreateColumnSql(nonGeneratedColumn, true)}`);
            downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${nonGeneratedColumn.name}\` ${this.buildCreateColumnSql(generatedColumn, true)}`);
        }

        // if table already have primary columns, we must drop them.
        const primaryColumns = clonedTable.primaryColumns;
        if (primaryColumns.length > 0) {
            const columnNames = primaryColumns.map(column => `\`${column.name}\``).join(", ");
            upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP PRIMARY KEY`);
            downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD PRIMARY KEY (${columnNames})`);
        }

        // update columns in table.
        clonedTable.columns
            .filter(column => columnNames.indexOf(column.name) !== -1)
            .forEach(column => column.isPrimary = true);

        const columnNamesString = columnNames.map(columnName => `\`${columnName}\``).join(", ");
        upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} ADD PRIMARY KEY (${columnNamesString})`);
        downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} DROP PRIMARY KEY`);

        // if we already have generated column or column is changed to generated, and we dropped AUTO_INCREMENT property before, we must bring it back
        const newOrExistGeneratedColumn = generatedColumn ? generatedColumn : columns.find(column => column.isGenerated && column.generationStrategy === "increment");
        if (newOrExistGeneratedColumn) {
            const nonGeneratedColumn = newOrExistGeneratedColumn.clone();
            nonGeneratedColumn.isGenerated = false;
            nonGeneratedColumn.generationStrategy = undefined;

            upQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${nonGeneratedColumn.name}\` ${this.buildCreateColumnSql(newOrExistGeneratedColumn, true)}`);
            downQueries.push(`ALTER TABLE ${this.escapeTableName(table)} CHANGE \`${newOrExistGeneratedColumn.name}\` ${this.buildCreateColumnSql(nonGeneratedColumn, true)}`);

            // if column changed to generated, we must update it in table
            const changedGeneratedColumn = clonedTable.columns.find(column => column.name === newOrExistGeneratedColumn.name);
            changedGeneratedColumn!.isGenerated = true;
            changedGeneratedColumn!.generationStrategy = "increment";
        }

        await this.executeQueries(upQueries, downQueries);
        this.replaceCachedTable(table, clonedTable);
        */
    }

    /**
     * Drops a primary key.
     */
    async dropPrimaryKey(tableOrName: Table|string): Promise<void> {
        throw new Error(`NYI: spanner: dropPrimaryKey`);
        /*
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const up = this.dropPrimaryKeySql(table);
        const down = this.createPrimaryKeySql(table, table.primaryColumns.map(column => column.name));
        await this.executeQueries(up, down);
        table.primaryColumns.forEach(column => {
            column.isPrimary = false;
        });
        */
    }

    /**
     * Creates a new unique constraint.
     */
    async createUniqueConstraint(tableOrName: Table|string, uniqueConstraint: TableUnique): Promise<void> {
        throw new Error(`NYI: spanner: createUniqueConstraint`);
    }

    /**
     * Creates a new unique constraints.
     */
    async createUniqueConstraints(tableOrName: Table|string, uniqueConstraints: TableUnique[]): Promise<void> {
        throw new Error(`NYI: spanner: createUniqueConstraints`);
    }

    /**
     * Drops an unique constraint.
     */
    async dropUniqueConstraint(tableOrName: Table|string, uniqueOrName: TableUnique|string): Promise<void> {
        throw new Error(`NYI: spanner: dropUniqueConstraint`);
    }

    /**
     * Drops an unique constraints.
     */
    async dropUniqueConstraints(tableOrName: Table|string, uniqueConstraints: TableUnique[]): Promise<void> {
        throw new Error(`NYI: spanner: dropUniqueConstraints`);
    }

    /**
     * Creates a new check constraint.
     */
    async createCheckConstraint(tableOrName: Table|string, checkConstraint: TableCheck): Promise<void> {
        throw new Error(`NYI: spanner: createCheckConstraint`);
    }

    /**
     * Creates a new check constraints.
     */
    async createCheckConstraints(tableOrName: Table|string, checkConstraints: TableCheck[]): Promise<void> {
        throw new Error(`NYI: spanner: createCheckConstraints`);
    }

    /**
     * Drops check constraint.
     */
    async dropCheckConstraint(tableOrName: Table|string, checkOrName: TableCheck|string): Promise<void> {
        throw new Error(`NYI: spanner: dropCheckConstraint`);
    }

    /**
     * Drops check constraints.
     */
    async dropCheckConstraints(tableOrName: Table|string, checkConstraints: TableCheck[]): Promise<void> {
        throw new Error(`NYI: spanner: dropCheckConstraints`);
    }

    /**
     * Creates a new foreign key. in spanner, it creates corresponding index too
     */
    async createForeignKey(tableOrName: Table|string, foreignKey: TableForeignKey): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);

        // new FK may be passed without name. In this case we generate FK name manually.
        if (!foreignKey.name)
            foreignKey.name = this.connection.namingStrategy.foreignKeyName(table.name, foreignKey.columnNames);

        const up = this.createForeignKeySql(table, foreignKey);
        const down = this.dropForeignKeySql(table, foreignKey);
        await this.executeQueries(up, down);
        table.addForeignKey(foreignKey);
    }

    /**
     * Creates a new foreign keys.
     */
    async createForeignKeys(tableOrName: Table|string, foreignKeys: TableForeignKey[]): Promise<void> {
        const promises = foreignKeys.map(foreignKey => this.createForeignKey(tableOrName, foreignKey));
        await Promise.all(promises);
    }

    /**
     * Drops a foreign key.
     */
    async dropForeignKey(tableOrName: Table|string, foreignKeyOrName: TableForeignKey|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const foreignKey = foreignKeyOrName instanceof TableForeignKey ? foreignKeyOrName : table.foreignKeys.find(fk => fk.name === foreignKeyOrName);
        if (!foreignKey)
            throw new Error(`Supplied foreign key was not found in table ${table.name}`);

        const up = this.dropForeignKeySql(table, foreignKey);
        const down = this.createForeignKeySql(table, foreignKey);
        await this.executeQueries(up, down);
        table.removeForeignKey(foreignKey);
    }

    /**
     * Drops a foreign keys from the table.
     */
    async dropForeignKeys(tableOrName: Table|string, foreignKeys: TableForeignKey[]): Promise<void> {
        const promises = foreignKeys.map(foreignKey => this.dropForeignKey(tableOrName, foreignKey));
        await Promise.all(promises);
    }

    /**
     * Creates a new index.
     */
    async createIndex(tableOrName: Table|string, index: TableIndex): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);

        // new index may be passed without name. In this case we generate index name manually.
        if (!index.name)
            index.name = this.connection.namingStrategy.indexName(table.name, index.columnNames, index.where);

        const up = this.createIndexSql(table, index);
        const down = this.dropIndexSql(table, index);
        await this.executeQueries(up, down);
        table.addIndex(index, true);
    }

    /**
     * Creates a new indices
     */
    async createIndices(tableOrName: Table|string, indices: TableIndex[]): Promise<void> {
        const promises = indices.map(index => this.createIndex(tableOrName, index));
        await Promise.all(promises);
    }

    /**
     * Drops an index.
     */
    async dropIndex(tableOrName: Table|string, indexOrName: TableIndex|string): Promise<void> {
        const table = tableOrName instanceof Table ? tableOrName : await this.getCachedTable(tableOrName);
        const index = indexOrName instanceof TableIndex ? indexOrName : table.indices.find(i => i.name === indexOrName);
        if (!index)
            throw new Error(`Supplied index was not found in table ${table.name}`);

        const up = this.dropIndexSql(table, index);
        const down = this.createIndexSql(table, index);
        await this.executeQueries(up, down);
        table.removeIndex(index, true);
    }

    /**
     * Drops an indices from the table.
     */
    async dropIndices(tableOrName: Table|string, indices: TableIndex[]): Promise<void> {
        const promises = indices.map(index => this.dropIndex(tableOrName, index));
        await Promise.all(promises);
    }

    /**
     * Clears all table contents.
     * Note: this operation uses SQL's TRUNCATE query which cannot be reverted in transactions.
     */
    async clearTable(tableOrName: Table|string): Promise<void> {
        throw new Error(`TODO: spanner: clearTable`);
        //await this.query(`TRUNCATE TABLE ${this.escapeTableName(tableOrName)}`);
    }

    /**
     * Removes all tables from the currently connected database.
     * Be careful using this method and avoid using it in production or migrations
     * (because it can clear all your database).
     */
    async clearDatabase(database?: string): Promise<void> {
        throw new Error(`TODO: spanner: clearDatabase`);
        /*const dbName = database ? database : this.driver.database;
        if (dbName) {
            const isDatabaseExist = await this.hasDatabase(dbName);
            if (!isDatabaseExist)
                return Promise.resolve();
        } else {
            throw new Error(`Can not clear database. No database is specified`);
        }

        await this.startTransaction();
        try {
            const disableForeignKeysCheckQuery = `SET FOREIGN_KEY_CHECKS = 0;`;
            const dropTablesQuery = `SELECT concat('DROP TABLE IF EXISTS \`', table_schema, '\`.\`', table_name, '\`') AS \`query\` FROM \`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_SCHEMA\` = '${dbName}'`;
            const enableForeignKeysCheckQuery = `SET FOREIGN_KEY_CHECKS = 1;`;

            await this.query(disableForeignKeysCheckQuery);
            const dropQueries: ObjectLiteral[] = await this.query(dropTablesQuery);
            await Promise.all(dropQueries.map(query => this.query(query["query"])));
            await this.query(enableForeignKeysCheckQuery);

            await this.commitTransaction();

        } catch (error) {
            try { // we throw original error even if rollback thrown an error
                await this.rollbackTransaction();
            } catch (rollbackError) { }
            throw error;
        }*/
    }

    /**
     * create `schemas` table which describe additional column information such as
     * generated column's increment strategy or default value
     * @database: spanner's database object. 
     */
    async createAndLoadSchemaTableIfNotExists(tableName?: string): Promise<SpannerExtendSchemas> {
        tableName = tableName || "schemas";
        const tableExist = await this.hasTable(tableName); // todo: table name should be configurable
        if (!tableExist) {
            await this.createTable(new Table(
                {
                    name: tableName,
                    columns: [
                        {
                            name: "table",
                            type: this.connection.driver.normalizeType({type: this.connection.driver.mappedDataTypes.migrationName}),
                            isPrimary: true,
                            isNullable: false
                        },
                        {
                            name: "column",
                            type: this.connection.driver.normalizeType({type: this.connection.driver.mappedDataTypes.migrationName}),
                            isPrimary: true,
                            isNullable: false
                        },
                        {
                            name: "type",
                            type: this.connection.driver.normalizeType({type: this.connection.driver.mappedDataTypes.migrationName}),
                            isPrimary: true,
                            isNullable: false
                        },
                        {
                            name: "value",
                            type: this.connection.driver.normalizeType({type: this.connection.driver.mappedDataTypes.migrationName}),
                            isNullable: false
                        },
                    ]
                },
            ));
        }

        const rawObjects: ObjectLiteral[] = (await this.connection.manager
            .createQueryBuilder(this)
            .select()
            .from(tableName, "")
            .getRawMany())
            // .map((o) => {
            //   console.log('GETTING RAW OBJECT', o)
            //     const v: { [k:string]:any } = {}
            //     for (const c of o) {
            //         console.log("C of O", c)
            //         v[c["name"]] = c["value"];
            //     }
            //     return v;
            // });

        const schemas: SpannerExtendSchemas = {};
        for (const rawObject of rawObjects) {
            const table = rawObject["table"];
            if (!schemas[table]) {
                schemas[table] = {};
            }
            const tableSchemas = schemas[table];
            const column = rawObject["column"];
            if (!tableSchemas[column]) {
                tableSchemas[column] = {}
            }
            const columnSchema = tableSchemas[column];
            const type = rawObject["type"];
            if (type === "generator") {
                const value = rawObject["value"];
                if (value == "uuid") {
                    columnSchema.generatorStorategy = "uuid";
                    columnSchema.generator = RandomGenerator.uuid4;
                } else if (value == "increment") {
                    columnSchema.generatorStorategy = "increment";
                    // we automatically process increment generation storategy as uuid. 
                    // because spanner strongly discourage auto increment column. 
                    // TODO: if there is request, implement auto increment somehow.
                    if (table !== "migrations") {
                        console.warn("warn: column value generatorStorategy `increment` treated as `uuid` on spanner, due to performance reason.");
                    }
                    columnSchema.generator = RandomGenerator.uuid4;
                }
            } else if (type === "default") {
                const value = rawObject["value"];
                columnSchema.default = value;
                columnSchema.generator = () => { return value; }

            }
        }
        return schemas;
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * check whether entity has all primary column key
     */
    protected doesValueContainAllPrimaryKeys(value: ObjectLiteral, table: Table): boolean {
        for (const pc of table.primaryColumns) {
            if (!(pc.name in value)) {
                return false;
            }
        }
        return true;
    }
    /**
     * get query string to examine select/update/upsert/delete keys. 
     * null means value contains all key elements already.
     */
    protected getKeyExamineQuery<Entity>(value: ObjectLiteral, table: Table, qb: QueryBuilder<Entity>): string|null {
        if (!this.doesValueContainAllPrimaryKeys(value, table)) {
            const whex = qb.whereExpression;
            return `SELECT ${table.primaryColumns.map((c) => c.name).join(',')} FROM ${qb.escapedMainTableName} ${whex}`
        } else {
            return null;
        }
    }

    /**
     * wrapper to integrate request by transaction and table
     * connect() should be already called before this function invoked.
     */
    protected request(table: Table, method: string, ...args: any[]): Promise<any> {
      // console.log('======================================================================')
      // console.log('SpannerqueryRunner.request')
      // console.log('table', table.name)
      // console.log('method', method)
      // console.log('args', JSON.stringify(args))
      // console.log('tx?', !!this.tx)
      // console.log('======================================================================')
        if (this.tx) {
            return this.tx[method](table.name, ...args);
        } else {
            return this.databaseConnection.table(table.name)[method](...args);
        }
    }

    /**
     * Handle select query
     */
    protected select<Entity>(qb: QueryBuilder<Entity>): Promise<any> {
        if(qb.connection.options.logging){
            if (qb.connection.options.logging !== false)
                console.log('select', qb.getSql(), this.databaseConnection);
        }
        if (!this.tx) {
            const [query, params] = qb.getQueryAndParameters();
            return this.databaseConnection.run({sql: query, params});
        } else {
            return new Promise(async (ok, fail) => {
                try {
                    const table = await this.getTable(qb.mainTableName);
                    if (!table) {
                        fail(new Error(`fatal: no such table ${qb.mainTableName}`));
                        return;
                    }
                    const tx = this.tx;
                    const whex = qb.whereExpression;
                    //TODO: check where expression contains all primary key of the table, 
                    //if contained, we can omit SELECT statement. 
                    //currently, I pray spanner's optimizer is so clever that it infers values of keys from where statement.
                    const query = `SELECT ${table.primaryColumns.map((c) => c.name).join(',')} FROM ${qb.escapedMainTableName} ${whex}`;
                    const [keys,err] = await this.databaseConnection.run(query);
                    if (err) {
                        this.driver.connection.logger.logQueryError(err, query, [], this);
                        fail(new QueryFailedError(query, [], err));
                        return;
                    }
                    if (!keys || keys.length <= 0) {
                        ok(); //nothing to select
                        return;
                    }
                    return tx.read(qb.mainTableName, keys, (err: Error, rows: any[]) => {
                        if (err) {
                            fail(err);
                        } else {
                            ok(rows);
                        }
                    });
                } catch (e) {
                    fail(e);
                }
            });            
        }
    }

    /**
     * Handle insert query
     */
    protected insert<Entity>(qb: QueryBuilder<Entity>): Promise<any> {
        if(qb.connection.options.logging){
            if (qb.connection.options.logging !== false)
                console.log('insert', qb.getSql());
        } 
        return new Promise(async (ok, fail) => {
            try {
                const table = await this.getTable(qb.mainTableName);
                if (!table) {
                    fail(new Error(`fatal: no such table ${qb.mainTableName}`));
                    return;
                }
                await this.request(table, 'insert', qb.expressionMap.valuesSet);
                ok(qb.expressionMap.valuesSet);
            } catch (e) {
                fail(e);
            }
        });
    }

    /**
     * Handle update query
     */
    protected update<Entity>(qb: QueryBuilder<Entity>): Promise<any> {
        if(qb.connection.options.logging){
            if (qb.connection.options.logging !== false)
                console.log('update', qb.getSql());
        } 
        return new Promise(async (ok, fail) => {
            try {
                let vs = qb.expressionMap.valuesSet instanceof Array ? qb.expressionMap.valuesSet : [qb.expressionMap.valuesSet];
                if (!vs || vs.length > 1 || (vs.length == 1 && !vs[0])) {
                    fail(new Error('only single value set can be used spanner update'));
                }
                const table = await this.getTable(qb.mainTableName);
                if (!table) {
                    fail(new Error(`fatal: no such table ${qb.mainTableName}`));
                    return;
                }
                const value = <ObjectLiteral>vs[0]; //above vs checks assure this cast is valid
                const query = this.getKeyExamineQuery(value, table, qb);
                if (query) {
                    const [keys,err] = await this.databaseConnection.run(query);
                    if (err) {
                        this.driver.connection.logger.logQueryError(err, query, [], this);
                        fail(new QueryFailedError(query, [], err));
                        return;
                    }
                    if (!keys || keys.length <= 0) {
                        ok(); //nothing to update
                        return;
                    }
                    const rows = keys;
                    for (const row of rows) {
                        Object.assign(row, value);
                    }
                    await this.request(table, 'update', rows);
                    ok(rows);                         
                } else {
                    await this.request(table, 'update', value);
                    ok(value);
                }
                //const query = `SELECT ${table.primaryColumns.map((c) => c.name).join(',')} FROM ${qb.escapedMainTableName} ${whex}`;
            } catch (e) {
                fail(e);
            }
        });
    }

    /**
     * Handle upsert query
     */
    protected upsert<Entity>(qb: QueryBuilder<Entity>): Promise<any> {
        if(qb.connection.options.logging){
            if (qb.connection.options.logging !== false)
                console.log('upsert', qb.getSql());
        } 
        return new Promise(async (ok, fail) => {
            try {
                let vs = qb.expressionMap.valuesSet instanceof Array ? qb.expressionMap.valuesSet : [qb.expressionMap.valuesSet];
                if (!vs || vs.length > 1 || (vs.length == 1 && !vs[0])) {
                    fail(new Error('only single value set can be used spanner upsert'));
                }
                const table = await this.getTable(qb.mainTableName);
                if (!table) {
                    fail(new Error(`fatal: no such table ${qb.mainTableName}`));
                    return;
                }
                const value = <ObjectLiteral>vs[0]; //above vs checks assure this cast is valid
                const query = this.getKeyExamineQuery(value, table, qb);
                if (query) {
                    const [keys,err] = await this.databaseConnection.run(query);
                    if (err) {
                        this.driver.connection.logger.logQueryError(err, query, [], this);
                        fail(new QueryFailedError(query, [], err));
                        return;
                    }
                    const rows = keys;
                    for (const row of rows) {
                        Object.assign(row, value);
                    }
                    await this.request(table, 'upsert', rows);
                    ok(rows);
                } else {
                    await this.request(table, 'upsert', value);
                    ok(value);
                }
            } catch (e) {
                fail(e);
            }
        });
    }

    /**
     * Handle delete query
     */
    protected delete<Entity>(qb: QueryBuilder<Entity>): Promise<any> {
        if(qb.connection.options.logging){
            if (qb.connection.options.logging !== false)
                console.log('delete', qb.getSql());
        } 
        return new Promise(async (ok, fail) => {
            try {
                const table = await this.getTable(qb.mainTableName);
                if (!table) {
                    fail(new Error(`fatal: no such table ${qb.mainTableName}`));
                    return;
                }
                //TODO: check where expression contains all primary key of the table, 
                //if contained, we can omit SELECT statement. 
                //currently, I pray spanner's optimizer is so clever that it infers values of keys from where statement.
                const whex = qb.whereExpression;
                const sql = `SELECT ${table.primaryColumns.map((c) => c.name).join(',')} FROM ${qb.escapedMainTableName} ${whex}`;
                const [query, parameters] = this.driver.escapeQueryWithParameters(sql, qb.getParameters(), {})
                const maybeParams = this.generateQueryParameters(parameters)
                const params = Object.keys(maybeParams).length ? maybeParams : undefined

                // console.log('CHECKING FOR ROWS TO DELETE')
                // console.log('SQL', query)
                // console.log("PARAMS", params)

                const [keys,err] = await this.databaseConnection.run({sql: query, params, json: true});
                if (err) {
                    this.driver.connection.logger.logQueryError(err, query, [], this);
                    fail(new QueryFailedError(query, [], err));
                    return;
                }
                if (!keys || keys.length <= 0) {
                    ok(); //nothing to delete
                    return;
                }

                /* Spanner expects keys differently depending on whether the table has a composite key or not:
                 *  Simple key: [KEY_VALUE]
                 *  Composite key: [[KEY_PART1, KEY_VALUE1], [KEY_PART2, KEY_VALUE2] ]
                 */
                const deleteKeys = keys.length > 1 
                  ? keys.map((key: ObjectLiteral) => {
                      const keyPart = Object.keys(key)[0] 
                      return [keyPart, key[keyPart]]
                    })
                    : keys.map((key: ObjectLiteral) => {
                      const keyPart = Object.keys(key)[0] 
                      return key[keyPart]
                    })

                await this.request(table, 'deleteRows', deleteKeys);
                ok();
            } catch (e) {
                fail(e);
            }
        });
    }

    /**
     * Handle administrative sqls as spanner API call
     */
    protected handleAdministrativeQuery(type: string, m: RegExpMatchArray): Promise<any>{
        return this.connect().then(conn => {
            if (type == "CREATE") {
                const p = m[2].split(/\s/);
                if (p[0] == "DATABASE") {
                    let name = p[1];
                    if (p[1] == "IF") {
                        if (p[2] != "NOT") {
                            return Promise.reject(new Error(`invalid query ${m[0]}`));
                        } else {
                            name = p[4];
                        }
                    }
                    return this.driver.createDatabase(name);
                }
            } else if (type == "DROP") {
                const p = m[2].split(/\s/);
                if (p[0] == "DATABASE") {
                    let name = p[1];
                    if (p[1] == "IF") {
                        if (p[2] != "EXISTS") {
                            return Promise.reject(new Error(`invalid query ${m[0]}`));
                        } else {
                            name = p[3];
                        }
                    }
                    return this.driver.dropDatabase(name);
                }
            }
            //others all updateSchema
            return conn.updateSchema(m[0]).then((data: any[]) => {
                return data[0].promise();
            });
        });
    }

    protected async simpleHandleAdministrativeQuery(statements: string[]): Promise<any>{
        const conn = await this.connect()
        const [data]: any[] = await conn.updateSchema(statements)
        return data.promise()
    }

    private generateQueryParameterAndTypes(parameters?: any[]): [{ [key: string]: any; }, { [key: string]: string }] {
      // console.log()
      // console.log('=================================================================================')
      // console.log('generateQueryParameterAndTypes')
      // console.log(parameters)
      
      const params: { [key: string]: any; } = {}
      const types: { [key: string]: string } = {}
      if (parameters) {
        parameters.forEach((p) => {
          params[p[0]] = p[1];
          if (p[2]) {
            types[p[0]] = p[2];
          }
        })
      }

      // console.log('params', params)
      // console.log('types', types)
      // console.log('=================================================================================')

      return [params, types];
    }

    private generateQueryParameters(parameters?: ObjectLiteral[]): ObjectLiteral {
      if (!parameters) {
        return {}
      }

      // return parameters.reduce((params, param) => ({ ...params, ...param}), {})
      const params: ObjectLiteral = {}
      parameters.forEach(p => {
        Object.keys(p).forEach(key => {
          params[key] = p[key]
        })
      })

      return params
    }

    /**
     * Loads all tables (with given names) from the database and creates a Table from them.
     */
    protected async loadTables(tableNames: string[]): Promise<Table[]> {
        // if no tables given then no need to proceed
        if (!tableNames || !tableNames.length)
            return [];

        return this.connect().then(() => {
            return this.driver.loadTables(tableNames);
        });
    }

    /**
     * Builds create table sql
     */
    protected createTableSql(table: Table, createForeignKeys?: boolean): string {
      // console.log('CREATE TABLE uniques', JSON.stringify(table.uniques, null, 2))
        const columnDefinitions = table.columns.map(column => this.buildCreateColumnSql(column, true)).join(", ");
        const escapedTableName = this.escapeTableName(table)
        let sql = `CREATE TABLE ${escapedTableName} (${columnDefinitions}`;

        // we create unique indexes instead of unique constraints, because MySql does not have unique constraints.
        // if we mark column as Unique, it means that we create UNIQUE INDEX.
        table.columns
            .filter(column => column.isUnique)
            .forEach(column => {
                const isUniqueIndexExist = table.indices.some(index => {
                    return index.columnNames.length === 1 && !!index.isUnique && index.columnNames.indexOf(column.name) !== -1;
                });
                const isUniqueConstraintExist = table.uniques.some(unique => {
                    return unique.columnNames.length === 1 && unique.columnNames.indexOf(column.name) !== -1;
                });
                if (!isUniqueIndexExist && !isUniqueConstraintExist)
                    table.indices.push(new TableIndex({
                        name: this.connection.namingStrategy.uniqueConstraintName(table.name, [column.name]),
                        columnNames: [column.name],
                        isUnique: true
                    }));
            });

        // as MySql does not have unique constraints, we must create table indices from table uniques and mark them as unique.
        if (table.uniques.length > 0) {
            table.uniques.forEach(unique => {
                const uniqueExist = table.indices.some(index => index.name === unique.name);
                if (!uniqueExist) {
                    table.indices.push(new TableIndex({
                        name: unique.name,
                        columnNames: unique.columnNames,
                        isUnique: true
                    }));
                }
            });
        }

        let indiciesSql: string = ''
        if (table.indices.length > 0) {
          indiciesSql = table.indices.map(index => {
                const columnNames = index.columnNames.map(columnName => `\`${columnName}\``).join(", ");
                if (!index.name)
                    index.name = this.connection.namingStrategy.indexName(table.name, index.columnNames, index.where);

                let indexType = "";
                if (index.isUnique)
                    indexType += "UNIQUE";
                if (index.isSpatial)
                    indexType += "NULL_FILTERED";
                if (index.isFulltext)
                    throw new Error(`NYI: spanner: index.isFulltext`); //indexType += "FULLTEXT ";

                return `CREATE ${indexType} INDEX \`${index.name}\` ON ${escapedTableName} (${columnNames});`;
            }).join(", ");
        }

        sql += `)`;

        if (table.primaryColumns.length > 0) {
            const columnNames = table.primaryColumns.map(column => `\`${column.name}\``).join(", ");
            sql += ` PRIMARY KEY (${columnNames})`;
        }

        if (table.foreignKeys.length > 0 && createForeignKeys) {
            const foreignKeysSql = table.foreignKeys.map(fk => {
                let constraint = `INTERLEAVE IN PARENT ${this.escapeTableName(fk.referencedTableName)}`;
                if (fk.onDelete)
                    constraint += ` ON DELETE ${fk.onDelete}`;
                if (fk.onUpdate)
                    throw new Error(`NYI: spanner: fk.onUpdate`); //constraint += ` ON UPDATE ${fk.onUpdate}`;

                return constraint;
            }).join(", ");

            sql += `, ${foreignKeysSql}`;
        }

        // console.log('SQL', sql)
        // console.log('INDICIES SQL:', indiciesSql)

        return `${sql}\n${indiciesSql}`;
    }

    /**
     * Builds drop table sql
     */
    protected dropTableSql(tableOrName: Table|string): string {
        return `DROP TABLE ${this.escapeTableName(tableOrName)}`;
    }

    /**
     * Builds create index sql.
     */
    protected createIndexSql(table: Table, index: TableIndex): string {
        //TODO: somehow supports interleave and storing clause
        const columns = index.columnNames.map(columnName => `\`${columnName}\``).join(", ");
        let indexType = "";
        if (index.isUnique)
            indexType += "UNIQUE ";
        if (index.isSpatial)
            indexType += "NULL_FILTERED ";
        if (index.isFulltext)
            throw new Error(`NYI: spanner: index.isFulltext`); //indexType += "FULLTEXT "; 
        return `CREATE ${indexType}INDEX \`${index.name}\` ON ${this.escapeTableName(table)}(${columns})`;
    }

    /**
     * Builds drop index sql.
     */
    protected dropIndexSql(table: Table, indexOrName: TableIndex|string): string {
        let indexName = indexOrName instanceof TableIndex ? indexOrName.name : indexOrName;
        return `DROP INDEX \`${indexName}\` ON ${this.escapeTableName(table)}`;
    }

    /**
     * Builds create primary key sql.
     */
    protected createPrimaryKeySql(table: Table, columnNames: string[]): string {
        const columnNamesString = columnNames.map(columnName => `\`${columnName}\``).join(", ");
        return `ALTER TABLE ${this.escapeTableName(table)} ADD PRIMARY KEY (${columnNamesString})`;
    }

    /**
     * Builds drop primary key sql.
     */
    protected dropPrimaryKeySql(table: Table): string {
        return `ALTER TABLE ${this.escapeTableName(table)} DROP PRIMARY KEY`;
    }

    /**
     * Builds create foreign key sql.
     */
    protected createForeignKeySql(table: Table, foreignKey: TableForeignKey): string {
        const referencedColumnNames = foreignKey.referencedColumnNames.map(column => `\`${column}\``).join(",");
        const fkName = foreignKey.name || `${foreignKey.referencedColumnNames}By${foreignKey.columnNames.join()}`;
        let sql = `CREATE INDEX ${fkName} ON ${this.escapeTableName(table.name)}(${referencedColumnNames}), INTERLEAVE IN ${this.escapeTableName(foreignKey.referencedTableName)}`;
        if (foreignKey.onDelete)
            sql += ` ON DELETE ${foreignKey.onDelete}`;
        if (foreignKey.onUpdate)
            throw new Error(`NYI: spanner: foreignKey.onUpdate`); //sql += ` ON UPDATE ${foreignKey.onUpdate}`;

        return sql;
    }

    /**
     * Builds drop foreign key sql.
     */
    protected dropForeignKeySql(table: Table, foreignKeyOrName: TableForeignKey|string): string {
        const foreignKeyName = foreignKeyOrName instanceof TableForeignKey ? foreignKeyOrName.name : foreignKeyOrName;
        return `DROP INDEX \`${foreignKeyName}\` ON ${this.escapeTableName(table)}`;
    }

    protected parseTableName(target: Table|string) {
        const tableName = target instanceof Table ? target.name : target;
        return {
            database: tableName.indexOf(".") !== -1 ? tableName.split(".")[0] : this.driver.database,
            tableName: tableName.indexOf(".") !== -1 ? tableName.split(".")[1] : tableName
        };
    }

    /**
     * Escapes given table name.
     */
    protected escapeTableName(target: Table|string, disableEscape?: boolean): string {
        const tableName = target instanceof Table ? target.name : target;
        let splits = tableName.split(".");
        if (splits.length > 1) {
            //omit database name to avoid spanner table name parse error.
            splits = splits.slice(1);
        }
        return splits.map(i => disableEscape ? i : `\`${i}\``).join(".");
    }
    
    /**
     * Builds a part of query to create/change a column.
     */
    protected buildCreateColumnSql(column: TableColumn, skipPrimary: boolean, skipName: boolean = false) {
        let c = "";
        if (skipName) {
            c = this.connection.driver.createFullType(column);
        } else {
            c = `\`${column.name}\` ${this.connection.driver.createFullType(column)}`;
        }
        if (column.asExpression)
            throw new Error(`NYI: spanner: column.asExpression`); // c += ` AS (${column.asExpression}) ${column.generatedType ? column.generatedType : "VIRTUAL"}`;

        // if you specify ZEROFILL for a numeric column, MySQL automatically adds the UNSIGNED attribute to that column.
        if (column.zerofill) {
            throw new Error(`NYI: spanner: column.zerofill`); // c += " ZEROFILL";
        } else if (column.unsigned) {
            throw new Error(`NYI: spanner: column.unsigned`); // c += " UNSIGNED";
        }

        // spanner
        if (column.enum) 
            throw new Error(`NYI: spanner: column.enum`); // c += ` (${column.enum.map(value => "'" + value + "'").join(", ")})`;

        // spanner only supports utf8
        if (column.charset && column.charset.toLowerCase().indexOf("utf8") >= 0)  
            throw new Error(`NYI: spanner: column.charset = ${column.charset}`); // c += ` CHARACTER SET "${column.charset}"`;
        if (column.collation) 
            throw new Error(`NYI: spanner: column.collation`); // c += ` COLLATE "${column.collation}"`;

        if (!column.isNullable)
            c += " NOT NULL";

        // explicit nullable modifier not supported. silently ignored.
        // if (column.isNullable) c += " NULL";
        
        // primary key can be specified only at table creation
        // not error but does not take effect here.
        // if (column.isPrimary && !skipPrimary) c += " PRIMARY KEY";

        // spanner does not support any generated columns, nor default value.
        // we should create metadata table and get information about generated columns
        // if (column.isGenerated && column.generationStrategy === "increment") {
        // }

        // does not support comment. 
        if (column.comment)
            throw new Error(`NYI: spanner: column.comment`); //c += ` COMMENT '${column.comment}'`;

        // // does not support any default value except SpannerColumnUpdateWithCommitTimestamp
        // if (column.default !== undefined && column.default !== null) {
        //     if (column.default !== SpannerColumnUpdateWithCommitTimestamp) {
        //         throw new Error(`NYI: spanner: column.default=${column.default}`); //c += ` DEFAULT ${column.default}`;
        //     } else {
        //         c += `OPTIONS (allow_commit_timestamp=true)`
        //     }
        // }
        if (column.default === SpannerColumnUpdateWithCommitTimestamp) {
            c += `OPTIONS (allow_commit_timestamp=true)`
        }
        
        // does not support on update
        if (column.onUpdate)
            throw new Error(`NYI: spanner: column.onUpdate`); //c += ` ON UPDATE ${column.onUpdate}`;

        return c;
    }

    protected buildCreateColumnOptionsSql(column: TableColumn): string {
        return "";
    }

    protected async syncExtendSchema(table: Table, column: TableColumn, remove?: boolean): Promise<void> {
        const promises: Promise<void>[] = [];
        if (!remove && column.default) {
            promises.push(this.upsertExtendSchema(table.name, column.name, "default", column.default));
        } else {
            promises.push(this.deleteExtendSchema(table.name, column.name, "default"));
        }
        if (!remove && column.generationStrategy) {
            promises.push(this.upsertExtendSchema(table.name, column.name, "generator", column.generationStrategy))
        } else {
            promises.push(this.deleteExtendSchema(table.name, column.name, "generator"));
        }
        await Promise.all(promises);
    }

    protected async deleteExtendSchema(table: string, column: string, type: string): Promise<void> {
        const qb = this.connection.manager
            .createQueryBuilder(this)
            .delete()
            .from(this.driver.options.schemaTableName || "schemas")
            .where(`\`table\` = '${table}' AND \`column\` = '${column}' AND \`type\` = '${type}'`);
        return this.delete(qb);
    }

    protected async upsertExtendSchema(table: string, column: string, type: string, value: string): Promise<void> {
        const qb = this.connection.manager
            .createQueryBuilder(this)
            .update(this.driver.options.schemaTableName || "schemas")
            .set({table, column, type, value})
            .where(`\`table\` = '${table}' AND \`column\` = '${column}' AND \`type\` = '${type}'`);
        return this.upsert(qb);
    }
}
