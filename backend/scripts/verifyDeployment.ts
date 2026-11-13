// backend/scripts/verifyDeployment.ts
//
// End-to-end smoke test of a live deployment. READ-ONLY: issues plain GETs and
// one CORS preflight, creates nothing, mutates nothing.
//
// Each check maps to a specific failure mode seen during this deploy, so a
// green run means those are genuinely ruled out — not merely "the page loaded".
//
// Usage:
//   npx tsx scripts/verifyDeployment.ts \
//     --backend=https://api.your-domain.example \
//     --frontend=https://app.your-domain.example

type Result = { name: string; ok: boolean; detail: string; critical: boolean };

const arg = (n: string) =>
    process.argv
        .find((a) => a.startsWith(`--${n}=`))
        ?.split("=")
        .slice(1)
        .join("=")
        ?.replace(/\/+$/, "");

const BACKEND = arg("backend");
const FRONTEND = arg("frontend");

if (!BACKEND || !FRONTEND) {
    console.error(
        "Usage: --backend=<railway origin> --frontend=<vercel origin>",
    );
    process.exit(1);
}

const results: Result[] = [];
function record(name: string, ok: boolean, detail: string, critical = true) {
    results.push({ name, ok, detail, critical });
}

async function fetchSafe(url: string, init?: RequestInit) {
    try {
        const res = await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(25_000),
        });
        return { res, err: null as string | null };
    } catch (e) {
        return { res: null, err: e instanceof Error ? e.message : String(e) };
    }
}

async function main() {
    console.log(`Backend : ${BACKEND}`);
    console.log(`Frontend: ${FRONTEND}\n`);

    // 1. Liveness.
    {
        const { res, err } = await fetchSafe(`${BACKEND}/health`);
        record(
            "backend /health",
            !!res && res.status === 200,
            err ?? `HTTP ${res?.status}`,
        );
    }

    // 2. Readiness — the check that caught the missing env twice.
    {
        const { res, err } = await fetchSafe(`${BACKEND}/health/ready`);
        let detail = err ?? `HTTP ${res?.status}`;
        let ok = false;
        if (res) {
            const body = (await res.json().catch(() => null)) as {
                ok?: boolean;
                checks?: Record<string, string>;
            } | null;
            ok =
                res.status === 200 &&
                body?.ok === true &&
                body?.checks?.libreoffice === "ok";
            if (body?.checks) {
                detail = Object.entries(body.checks)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(" ");
            }
        }
        record(
            "backend /health/ready (Supabase + R2 + LibreOffice)",
            ok,
            detail,
        );
    }

    // 3. Auth actually enforced on data routes.
    for (const path of ["/projects", "/chat", "/firm-memory/entries"]) {
        const { res, err } = await fetchSafe(`${BACKEND}${path}`);
        record(
            `auth required on ${path}`,
            !!res && res.status === 401,
            err ?? `HTTP ${res?.status} (want 401)`,
        );
    }

    // 4. CORS: the real frontend origin must be allowlisted. This is the wiring
    //    that stays broken until FRONTEND_URL/CORS_ORIGINS are re-pointed after
    //    the frontend deploy.
    {
        const { res, err } = await fetchSafe(`${BACKEND}/health`, {
            method: "OPTIONS",
            headers: {
                Origin: FRONTEND,
                "Access-Control-Request-Method": "GET",
            },
        });
        const allow = res?.headers.get("access-control-allow-origin") ?? "";
        record(
            "CORS allows the frontend origin",
            !!res && res.status < 400 && allow.includes(new URL(FRONTEND).host),
            err ?? `HTTP ${res?.status}, allow-origin: ${allow || "(none)"}`,
        );
    }

    // 5. Frontend reachable.
    {
        const { res, err } = await fetchSafe(FRONTEND);
        record(
            "frontend root loads",
            !!res && res.status < 400,
            err ?? `HTTP ${res?.status}`,
        );
    }

    // 6. Signup renders the allowlist-gated form and clearly tells the user
    //    that only administrator-approved addresses may register. The actual
    //    enforcement lives in Supabase's fail-closed auth.users trigger; this
    //    read-only smoke check guards the production UI contract.
    {
        const { res, err } = await fetchSafe(`${FRONTEND}/signup`);
        const html = res ? await res.text().catch(() => "") : "";
        const hasForm = /Create Account/i.test(html);
        const explainsAllowlist = /Access is limited to approved addresses/i.test(
            html,
        );
        record(
            "signup page communicates the allowlist gate",
            !!res && res.status < 400 && hasForm && explainsAllowlist,
            err ??
                `HTTP ${res?.status}, form=${hasForm}, allowlistCopy=${explainsAllowlist}`,
        );
    }

    // 7. Login page renders.
    {
        const { res, err } = await fetchSafe(`${FRONTEND}/login`);
        const html = res ? await res.text().catch(() => "") : "";
        record(
            "login page renders",
            !!res && res.status < 400 && /Log ?In/i.test(html),
            err ?? `HTTP ${res?.status}`,
        );
    }

    // 8. The signer route exists (e-signature links land somewhere real).
    {
        const { res, err } = await fetchSafe(
            `${FRONTEND}/sign/smoke-test-token`,
        );
        record(
            "e-signature signer route exists",
            !!res && res.status < 500,
            err ?? `HTTP ${res?.status}`,
            false,
        );
    }

    // Report.
    const pad = Math.max(...results.map((r) => r.name.length));
    console.log("─".repeat(pad + 34));
    for (const r of results) {
        const mark = r.ok ? "PASS" : r.critical ? "FAIL" : "warn";
        console.log(`  [${mark}] ${r.name.padEnd(pad)}  ${r.detail}`);
    }
    console.log("─".repeat(pad + 34));

    const failed = results.filter((r) => !r.ok && r.critical);
    if (failed.length === 0) {
        console.log("\nAll critical checks passed. Stack is wired end to end.");
        console.log(
            "Still requires a human: per-user isolation, memory recall across chats,\n" +
                "firm-memory approval, and the inbound-email ATTACHMENT check.",
        );
    } else {
        console.log(`\n${failed.length} critical check(s) failed:`);
        for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
