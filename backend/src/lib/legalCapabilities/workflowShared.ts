/**
 * Re-exports the column-config shape used by tabular workflows. Mirrors
 * the frontend shared/types.ts definition so backend code does not need
 * to reach across the package boundary.
 */

export type ColumnFormat =
    | "text"
    | "bulleted_list"
    | "number"
    | "currency"
    | "yes_no"
    | "date"
    | "tag"
    | "percentage"
    | "monetary_amount";

export interface ColumnConfig {
    index: number;
    name: string;
    prompt: string;
    format?: ColumnFormat;
    tags?: string[];
}
