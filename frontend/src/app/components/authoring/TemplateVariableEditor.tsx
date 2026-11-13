"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { DocTemplateVariable } from "../shared/types";

let rowIdCounter = 0;
/** Monotonic local id for a variable row — never leaves the component. */
function nextRowId(): string {
    rowIdCounter += 1;
    return `var-${rowIdCounter}`;
}

interface Props {
    value: DocTemplateVariable[];
    onChange: (next: DocTemplateVariable[]) => void;
    /** When true, renders the schema read-only: inputs disabled, no add/remove. */
    readOnly?: boolean;
}

/** The 10 variable types, in the order they appear in the type <select>. */
const VARIABLE_TYPES: DocTemplateVariable["type"][] = [
    "party",
    "date",
    "money",
    "jurisdiction",
    "enum",
    "text",
    "multiline",
    "number",
    "boolean",
    "duration",
];

const TYPE_LABELS: Record<DocTemplateVariable["type"], string> = {
    party: "Party",
    date: "Date",
    money: "Money",
    jurisdiction: "Jurisdiction",
    enum: "Enum (choices)",
    text: "Text",
    multiline: "Multiline",
    number: "Number",
    boolean: "Boolean",
    duration: "Duration",
};

const EMPTY_VARIABLE: DocTemplateVariable = {
    name: "",
    label: "",
    type: "text",
    required: false,
};

const inputClass =
    "rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500";

/**
 * Controlled editor for a template's variable SCHEMA (`DocTemplateVariable[]`).
 * Presentational only — no data fetching. Used by the template-authoring and
 * template-detail modals (the latter passes `readOnly`).
 */
export function TemplateVariableEditor({ value, onChange, readOnly }: Props) {
    // Stable, local-only ids parallel to `value` — used as the row React key so
    // removing/inserting a row reconciles per-row DOM state (focus, the enum
    // "Choices" sub-input) against the right logical variable. The ids are
    // positional: rowIds[i] belongs to value[i]. They are NOT part of the
    // schema and never leave the component.
    const [rowIds, setRowIds] = useState<string[]>(() =>
        value.map(() => nextRowId()),
    );
    // An EXTERNAL `value` change (parent resets or loads a whole schema) can
    // desync the lengths; reconcile via the guarded render-phase setState from
    // react.dev "adjusting state when props change": append fresh ids when
    // value grew, truncate when it shrank. The length guard makes this run at
    // most once per external change — no render loop — and React re-renders
    // with the adjusted ids before committing. The internal add/remove
    // handlers below keep ids in lockstep themselves so individual edits
    // preserve each surviving row's identity.
    if (rowIds.length !== value.length) {
        setRowIds(
            value.map((_, i) => (i < rowIds.length ? rowIds[i] : nextRowId())),
        );
    }

    function updateVariable(index: number, patch: Partial<DocTemplateVariable>) {
        onChange(
            value.map((variable, i) =>
                i === index ? { ...variable, ...patch } : variable,
            ),
        );
    }

    function changeType(index: number, type: DocTemplateVariable["type"]) {
        const current = value[index];
        // Drop enum_options when leaving the enum type so the schema stays clean.
        if (type !== "enum" && current.enum_options !== undefined) {
            const rest = { ...current };
            delete rest.enum_options;
            onChange(value.map((v, i) => (i === index ? { ...rest, type } : v)));
            return;
        }
        updateVariable(index, { type });
    }

    function addVariable() {
        // Append an id so it lines up with the new last element; the
        // render-time reconcile would also add one, but doing it here keeps
        // the surviving rows' ids untouched.
        setRowIds((prev) => [...prev, nextRowId()]);
        onChange([...value, { ...EMPTY_VARIABLE }]);
    }

    function removeVariable(index: number) {
        // Drop id i in lockstep with variable i so every OTHER row keeps its
        // existing id (and thus its focus / enum sub-input DOM state).
        setRowIds((prev) => prev.filter((_, i) => i !== index));
        onChange(value.filter((_, i) => i !== index));
    }

    return (
        <div className="space-y-3">
            {value.length === 0 && (
                <p className="rounded-md border border-dashed border-gray-200 px-3 py-6 text-center text-sm text-gray-400">
                    No variables yet.
                    {!readOnly && " Add one to start building the intake form."}
                </p>
            )}

            {value.map((variable, index) => {
                const isEnum = variable.type === "enum";
                return (
                    <div
                        key={rowIds[index] ?? index}
                        className="rounded-lg border border-gray-200 p-3"
                    >
                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                value={variable.name}
                                onChange={(e) =>
                                    updateVariable(index, {
                                        name: e.target.value,
                                    })
                                }
                                placeholder="name (e.g. tenant_name)"
                                disabled={readOnly}
                                className={`${inputClass} min-w-0 flex-1 font-mono`}
                            />
                            <input
                                value={variable.label}
                                onChange={(e) =>
                                    updateVariable(index, {
                                        label: e.target.value,
                                    })
                                }
                                placeholder="Label (e.g. Tenant name)"
                                disabled={readOnly}
                                className={`${inputClass} min-w-0 flex-1`}
                            />
                            <select
                                value={variable.type}
                                onChange={(e) =>
                                    changeType(
                                        index,
                                        e.target
                                            .value as DocTemplateVariable["type"],
                                    )
                                }
                                disabled={readOnly}
                                className={`${inputClass} bg-white disabled:bg-gray-50`}
                            >
                                {VARIABLE_TYPES.map((type) => (
                                    <option key={type} value={type}>
                                        {TYPE_LABELS[type]}
                                    </option>
                                ))}
                            </select>
                            <label className="flex items-center gap-1.5 whitespace-nowrap text-sm text-gray-600">
                                <input
                                    type="checkbox"
                                    checked={variable.required}
                                    onChange={(e) =>
                                        updateVariable(index, {
                                            required: e.target.checked,
                                        })
                                    }
                                    disabled={readOnly}
                                    className="h-3.5 w-3.5 rounded border-gray-300 accent-black disabled:opacity-50"
                                />
                                Required
                            </label>
                            {!readOnly && (
                                <button
                                    type="button"
                                    onClick={() => removeVariable(index)}
                                    aria-label="Remove variable"
                                    className="rounded-md p-1.5 text-gray-300 hover:bg-gray-100 hover:text-red-500"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </div>

                        {isEnum && (
                            <div className="mt-3">
                                <label className="mb-1 block text-xs font-medium text-gray-500">
                                    Choices (comma-separated)
                                </label>
                                <input
                                    value={(variable.enum_options ?? []).join(
                                        ", ",
                                    )}
                                    onChange={(e) =>
                                        updateVariable(index, {
                                            enum_options: e.target.value
                                                .split(",")
                                                .map((opt) => opt.trim())
                                                .filter(
                                                    (opt) => opt.length > 0,
                                                ),
                                        })
                                    }
                                    placeholder="Gross, Net, Modified Gross"
                                    disabled={readOnly}
                                    className={`${inputClass} w-full`}
                                />
                            </div>
                        )}
                    </div>
                );
            })}

            {!readOnly && (
                <button
                    type="button"
                    onClick={addVariable}
                    className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
                >
                    <Plus className="h-3.5 w-3.5" />
                    Add variable
                </button>
            )}
        </div>
    );
}
