// Command-line parsing for scripts/seedFirm.ts.
//
// Kept apart from the script so the rules (defaults, normalization, the
// admins-are-always-allowed merge, input errors) are unit-testable without a
// database.

export type FirmSeedConfig = {
    name: string;
    slug: string;
    admins: string[];
    allowed: string[];
    apply: boolean;
};

const DEFAULT_NAME = "My Firm";
/** The slug migration 027 seeds and FALLBACK_FIRM_ID in playbooks.ts. */
const DEFAULT_SLUG = "pilot-firm";
const VALUE_FLAGS = new Set(["--name", "--slug", "--admin", "--allow"]);

function emailList(raw: string, flag: string): string[] {
    return raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
        .map((email) => {
            if (!email.includes("@")) {
                throw new Error(`${flag}: "${email}" is not an email address`);
            }
            return email;
        });
}

export function parseFirmSeedArgs(argv: string[]): FirmSeedConfig {
    let name = DEFAULT_NAME;
    let slug = DEFAULT_SLUG;
    let apply = false;
    const admins: string[] = [];
    const allowed: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === "--apply") {
            apply = true;
            continue;
        }
        if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown flag: ${flag}`);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`Missing value for ${flag}`);
        }
        i++;
        if (flag === "--name") name = value.trim();
        else if (flag === "--slug") slug = value.trim();
        else if (flag === "--admin") admins.push(...emailList(value, flag));
        else allowed.push(...emailList(value, flag));
    }

    const unique = (values: string[]) => [...new Set(values)];
    return {
        name,
        slug,
        admins: unique(admins),
        allowed: unique([...admins, ...allowed]),
        apply,
    };
}
