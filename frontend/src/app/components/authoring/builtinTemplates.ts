// Static catalog of the built-in CRE document types surfaced in the
// template-management and drafting UIs. Presentational metadata only — the
// authoritative templates (with skeletons + variable schemas) are seeded
// server-side (migration 020) and resolved via the templates API. This catalog
// drives the "start from a built-in" affordances and the doc_type → label map.

export interface BuiltinTemplate {
    slug: string;
    title: string;
    doc_type: string;
    practice: string;
    description: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
    {
        slug: "commercial-lease",
        title: "Commercial Lease Agreement",
        doc_type: "commercial_lease",
        practice: "Real Estate",
        description: "Standard U.S. commercial lease.",
    },
    {
        slug: "purchase-and-sale-agreement",
        title: "Purchase and Sale Agreement",
        doc_type: "psa",
        practice: "Real Estate",
        description: "Commercial property PSA.",
    },
    {
        slug: "letter-of-intent",
        title: "Letter of Intent",
        doc_type: "loi",
        practice: "Real Estate",
        description: "Non-binding LOI for a CRE deal.",
    },
    {
        slug: "estoppel-certificate",
        title: "Estoppel Certificate",
        doc_type: "estoppel",
        practice: "Real Estate",
        description: "Tenant estoppel certificate.",
    },
    {
        slug: "snda",
        title: "SNDA",
        doc_type: "snda",
        practice: "Real Estate",
        description: "Subordination, non-disturbance & attornment.",
    },
    {
        slug: "lease-amendment",
        title: "Lease Amendment",
        doc_type: "amendment",
        practice: "Real Estate",
        description: "Amendment to an existing lease.",
    },
];

/** Map of doc_type → human title, derived from the built-in catalog. */
export const DOC_TYPE_LABELS: Record<string, string> = Object.fromEntries(
    BUILTIN_TEMPLATES.map((t) => [t.doc_type, t.title]),
);
