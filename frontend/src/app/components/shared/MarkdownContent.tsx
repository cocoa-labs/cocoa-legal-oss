"use client";

import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { displayCitationQuote, formatCitationPage } from "./types";
import type { CocoLegalCitationAnnotation } from "./types";

// ---------------------------------------------------------------------------
// Markdown renderer (shared config)
//
// The canonical assistant-prose renderer. Extracted verbatim from
// AssistantMessage so other surfaces (e.g. the recordings summary card) render
// Markdown identically without pulling in a second markdown lib — and without a
// circular import back into AssistantMessage, which imports those cards.
//
// Callers with no citations pass `citationsList={[]}`; the `§idx§` code-block
// branch simply never matches, so plain prose renders unchanged.
// ---------------------------------------------------------------------------

export function MarkdownContent({
    text,
    citationsList,
    onCitationClick,
    divRef,
}: {
    text: string;
    citationsList: CocoLegalCitationAnnotation[];
    onCitationClick?: (c: CocoLegalCitationAnnotation) => void;
    divRef?: React.RefObject<HTMLDivElement | null>;
}) {
    return (
        <div
            ref={divRef}
            className="text-gray-900 mb-4 text-base prose prose-sm max-w-none font-serif"
        >
            <ReactMarkdown
                remarkPlugins={[
                    [remarkMath, { singleDollarTextMath: false }],
                    remarkGfm,
                ]}
                rehypePlugins={[rehypeKatex]}
                components={{
                    table: ({ node, ...props }) => {
                        void node;
                        return (
                            <div className="overflow-x-auto my-4">
                                <table
                                    className="min-w-full divide-y divide-gray-300 border border-gray-200 rounded-lg overflow-hidden"
                                    {...props}
                                />
                            </div>
                        );
                    },
                    thead: ({ node, ...props }) => {
                        void node;
                        return <thead className="bg-gray-50" {...props} />;
                    },
                    tbody: ({ node, ...props }) => {
                        void node;
                        return (
                            <tbody
                                className="divide-y divide-gray-200 bg-white"
                                {...props}
                            />
                        );
                    },
                    tr: ({ node, ...props }) => {
                        void node;
                        return <tr {...props} />;
                    },
                    th: ({ node, ...props }) => {
                        void node;
                        return (
                            <th
                                className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900"
                                {...props}
                            />
                        );
                    },
                    td: ({ node, ...props }) => {
                        void node;
                        return (
                            <td
                                className="whitespace-normal px-3 py-4 text-sm text-gray-900"
                                {...props}
                            />
                        );
                    },
                    h1: ({ node, ...props }) => {
                        void node;
                        return (
                            <h1
                                className="mt-6 mb-4 text-3xl font-serif font-semibold"
                                {...props}
                            />
                        );
                    },
                    h2: ({ node, ...props }) => {
                        void node;
                        return (
                            <h2
                                className="mt-5 mb-3 text-2xl font-serif font-semibold"
                                {...props}
                            />
                        );
                    },
                    h3: ({ node, ...props }) => {
                        void node;
                        return (
                            <h3
                                className="text-xl font-semibold mt-4 mb-2"
                                {...props}
                            />
                        );
                    },
                    h4: ({ node, ...props }) => {
                        void node;
                        return (
                            <h4
                                className="text-lg font-semibold mt-4 mb-2"
                                {...props}
                            />
                        );
                    },
                    p: ({ node, ...props }) => {
                        const parent =
                            node && "parent" in node
                                ? (node as { parent?: { type?: string } }).parent
                                : undefined;
                        if (parent?.type === "listItem") {
                            return (
                                <p
                                    className="inline leading-7 m-0"
                                    {...props}
                                />
                            );
                        }
                        return <p className="mb-4 leading-7" {...props} />;
                    },
                    ul: ({ node, ...props }) => {
                        void node;
                        return (
                            <ul
                                className="list-disc list-outside mb-4 pl-6"
                                {...props}
                            />
                        );
                    },
                    ol: ({ node, ...props }) => {
                        void node;
                        return (
                            <ol
                                className="list-decimal list-outside mb-4 pl-6"
                                {...props}
                            />
                        );
                    },
                    li: ({ node, ...props }) => {
                        void node;
                        return <li className="mb-2 leading-7" {...props} />;
                    },
                    strong: ({ node, ...props }) => {
                        void node;
                        return <strong className="font-semibold" {...props} />;
                    },
                    em: ({ node, ...props }) => {
                        void node;
                        return <em className="italic" {...props} />;
                    },
                    code: ({ node, children, ...props }) => {
                        void node;
                        const text = String(children);
                        const citMatch = text.match(/^§(\d+)§$/);
                        if (citMatch) {
                            const idx = parseInt(citMatch[1]);
                            const annotation = citationsList[idx];
                            if (annotation) {
                                const tooltipText = `${formatCitationPage(annotation)}: "${displayCitationQuote(annotation)}"`;
                                return (
                                    <button
                                        onClick={() => {
                                            console.log(
                                                "[AssistantMessage] citation clicked",
                                                annotation,
                                            );
                                            onCitationClick?.(annotation);
                                        }}
                                        className="mx-0.5 inline-flex items-center justify-center rounded-full w-4 h-4 text-[10px] font-medium transition-colors align-super bg-gray-100 text-gray-900 hover:bg-gray-200"
                                        title={tooltipText}
                                    >
                                        {idx + 1}
                                    </button>
                                );
                            }
                        }
                        return (
                            <code
                                className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-serif"
                                {...props}
                            >
                                {children}
                            </code>
                        );
                    },
                    blockquote: ({ node, ...props }) => {
                        void node;
                        return (
                            <blockquote
                                className="border-l-4 border-gray-300 pl-4 italic my-4"
                                {...props}
                            />
                        );
                    },
                    a: ({ node, href, children, ...props }) => {
                        void node;
                        return (
                            <a
                                href={href}
                                className="text-blue-600 hover:text-blue-700 underline"
                                target="_blank"
                                rel="noopener noreferrer"
                                {...props}
                            >
                                {children}
                            </a>
                        );
                    },
                    hr: ({ node, ...props }) => {
                        void node;
                        return <hr className="my-6 border-gray-200" {...props} />;
                    },
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}
