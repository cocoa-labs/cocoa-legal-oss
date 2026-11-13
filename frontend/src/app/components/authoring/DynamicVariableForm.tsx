"use client";

import { useEffect } from "react";
import type { DocTemplateVariable } from "../shared/types";

interface Props {
    schema: DocTemplateVariable[];
    values: Record<string, unknown>;
    onChange: (next: Record<string, unknown>) => void;
    /** Advisory: fired whenever inputs change with whether the form is fillable. */
    onValidityChange?: (valid: boolean) => void;
}

const DEFAULT_GROUP = "Details";

const fieldClass =
    "w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none";

/** True when a `dependsOn`-gated variable should currently be shown. */
function isVisible(
    variable: DocTemplateVariable,
    values: Record<string, unknown>,
): boolean {
    if (!variable.dependsOn) return true;
    return values[variable.dependsOn.name] === variable.dependsOn.equals;
}

/** A value counts as "filled" when it is not empty/blank/undefined. */
function isFilled(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    // A checkbox always carries a deliberate answer: checked (true) and
    // unchecked (false) are BOTH valid. Treat any boolean as filled so a
    // required boolean never dead-ends Generate. This matches the backend
    // validateVariables, which counts `false` as present (only undefined/
    // null/"" are "missing").
    if (typeof value === "boolean") return true;
    return true;
}

/**
 * Light per-type sanity check on a FILLED value (empty values are handled by the
 * required check, not here). Returns false only when a provided value is
 * malformed for its type — advisory, never blocks typing.
 */
function passesTypeCheck(
    variable: DocTemplateVariable,
    value: unknown,
): boolean {
    switch (variable.type) {
        case "date": {
            const ms = Date.parse(String(value));
            return Number.isFinite(ms);
        }
        case "money":
        case "number": {
            const n =
                typeof value === "number"
                    ? value
                    : Number(String(value).replace(/[$,\s]/g, ""));
            return Number.isFinite(n);
        }
        case "enum": {
            const options = variable.enum_options ?? [];
            return options.includes(String(value));
        }
        default:
            return true;
    }
}

/**
 * Compute advisory validity: every visible+required field is filled, and every
 * filled visible field passes its per-type check. Hidden (dependsOn) fields are
 * exempt.
 */
function computeValid(
    schema: DocTemplateVariable[],
    values: Record<string, unknown>,
): boolean {
    for (const variable of schema) {
        if (!isVisible(variable, values)) continue;
        const value = values[variable.name];
        const filled = isFilled(value);
        if (variable.required && !filled) return false;
        if (filled && !passesTypeCheck(variable, value)) return false;
    }
    return true;
}

/** Stable, insertion-ordered list of distinct group headings in the schema. */
function groupOrder(schema: DocTemplateVariable[]): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const variable of schema) {
        const group = variable.group?.trim() || DEFAULT_GROUP;
        if (!seen.has(group)) {
            seen.add(group);
            order.push(group);
        }
    }
    return order;
}

/**
 * Renders fillable inputs generated FROM a variable schema (the drafting
 * wizard's intake step). Controlled, no data fetching. Fields are grouped by
 * `variable.group`, hidden when their `dependsOn` is unmet, and validity is
 * reported (advisorily) via `onValidityChange`.
 */
export function DynamicVariableForm({
    schema,
    values,
    onChange,
    onValidityChange,
}: Props) {
    // Advisory validity — recomputed whenever the schema or any value changes.
    useEffect(() => {
        onValidityChange?.(computeValid(schema, values));
        // onValidityChange intentionally omitted: callers may pass an inline fn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [schema, values]);

    function setValue(name: string, value: unknown) {
        onChange({ ...values, [name]: value });
    }

    const groups = groupOrder(schema);

    return (
        <div className="space-y-6">
            {groups.map((group) => {
                const fields = schema.filter(
                    (variable) =>
                        (variable.group?.trim() || DEFAULT_GROUP) === group &&
                        isVisible(variable, values),
                );
                if (fields.length === 0) return null;
                return (
                    <div key={group} className="space-y-4">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                            {group}
                        </h3>
                        {fields.map((variable) => (
                            <Field
                                key={variable.name}
                                variable={variable}
                                value={values[variable.name]}
                                onChange={(v) => setValue(variable.name, v)}
                            />
                        ))}
                    </div>
                );
            })}
        </div>
    );
}

function Field({
    variable,
    value,
    onChange,
}: {
    variable: DocTemplateVariable;
    value: unknown;
    onChange: (value: unknown) => void;
}) {
    const id = `field-${variable.name}`;

    if (variable.type === "boolean") {
        return (
            <label
                htmlFor={id}
                className="flex items-start gap-2 text-sm text-gray-700"
            >
                <input
                    id={id}
                    type="checkbox"
                    checked={value === true}
                    onChange={(e) => onChange(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-gray-300 accent-black"
                />
                <span>
                    {variable.label}
                    {variable.required && (
                        <span className="ml-0.5 text-red-500">*</span>
                    )}
                    {variable.help && (
                        <span className="mt-0.5 block text-xs font-normal text-gray-400">
                            {variable.help}
                        </span>
                    )}
                </span>
            </label>
        );
    }

    return (
        <div>
            <label
                htmlFor={id}
                className="mb-1.5 block text-sm font-medium text-gray-600"
            >
                {variable.label}
                {variable.required && (
                    <span className="ml-0.5 text-red-500">*</span>
                )}
            </label>
            <FieldInput id={id} variable={variable} value={value} onChange={onChange} />
            {variable.help && (
                <p className="mt-1 text-xs text-gray-400">{variable.help}</p>
            )}
        </div>
    );
}

function FieldInput({
    id,
    variable,
    value,
    onChange,
}: {
    id: string;
    variable: DocTemplateVariable;
    value: unknown;
    onChange: (value: unknown) => void;
}) {
    const str = value === undefined || value === null ? "" : String(value);

    switch (variable.type) {
        case "multiline":
            return (
                <textarea
                    id={id}
                    rows={4}
                    value={str}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={variable.label}
                    className={`${fieldClass} resize-none leading-6`}
                />
            );

        case "date":
            return (
                <input
                    id={id}
                    type="date"
                    value={str}
                    onChange={(e) => onChange(e.target.value)}
                    className={fieldClass}
                />
            );

        case "money":
        case "number":
            return (
                <input
                    id={id}
                    type="text"
                    inputMode="decimal"
                    value={str}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={variable.type === "money" ? "0.00" : "0"}
                    className={fieldClass}
                />
            );

        case "enum":
            return (
                <select
                    id={id}
                    value={str}
                    onChange={(e) => onChange(e.target.value)}
                    className={`${fieldClass} bg-white`}
                >
                    <option value="">Select…</option>
                    {(variable.enum_options ?? []).map((option) => (
                        <option key={option} value={option}>
                            {option}
                        </option>
                    ))}
                </select>
            );

        case "duration":
            return (
                <input
                    id={id}
                    type="text"
                    value={str}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="e.g. 5 years"
                    className={fieldClass}
                />
            );

        // party | text | jurisdiction (and any fallthrough) → plain text input
        default:
            return (
                <input
                    id={id}
                    type="text"
                    value={str}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={variable.label}
                    className={fieldClass}
                />
            );
    }
}
