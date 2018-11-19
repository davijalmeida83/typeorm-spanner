import {BaseConnectionOptions} from "../../connection/BaseConnectionOptions";
import { SpannerCredentials } from "./SpannerRawTypes";

/**
 * Spanner-specific connection options.
 */
export interface SpannerConnectionOptions extends BaseConnectionOptions {

    /**
     * Database type.
     */
    readonly type: "spanner";

    /**
     * project id which holds spanner instances.
     */
    readonly projectId: string;

    /**
     * instance id of spanner node.
     */
    readonly instanceId: string;

    /**
     * spanner database id (name)
     */
    readonly database: string;

    /**
     * Google service account credentials
     */
    readonly credentials?: SpannerCredentials;

    /**
     * Automatically create the database if it doesn't exist
     */
    readonly autoCreate: boolean;

    /**
     * extended schema infromation table name
     */
    readonly schemaTableName?: string;

    /**
     * migration ddl type. if not specified, ddl should be pure spanner's one
     */
    readonly migrationDDLType?: "mysql";
}