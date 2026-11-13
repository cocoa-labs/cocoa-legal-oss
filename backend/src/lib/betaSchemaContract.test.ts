import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function migration(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "migrations", name), "utf8");
}

const tenancy = migration("034_beta_tenancy.sql");
assert.match(tenancy, /invitation_expires_at\s+timestamptz/i);
assert.match(tenancy, /now\(\) \+ interval '7 days'/i);
assert.match(tenancy, /status = 'invited'[\s\S]+invitation_expires_at > now\(\)/i);
assert.match(tenancy, /revoke all on function public\.invite_project_member[\s\S]+authenticated/i);
assert.doesNotMatch(
  tenancy.match(/p_role <> all\(array\[([^\]]+)/i)?.[1] ?? "",
  /owner/i,
  "the invitation RPC must never create a second owner",
);

const tasks = migration("035_matter_tasks.sql");
assert.match(tasks, /revision integer not null default 1/i);
assert.match(tasks, /email_sent[\s\S]+signature_completed[\s\S]+document_version_created[\s\S]+operation_succeeded/i);
assert.match(tasks, /revoke all on public\.matter_tasks from anon, authenticated/i);

const operations = migration("036_beta_operations.sql");
const rateLimitClockFix = migration("037_fix_rate_limit_clock.sql");
assert.match(operations, /create table if not exists public\.audit_events/i);
assert.match(operations, /create trigger audit_events_immutable/i);
assert.match(operations, /create trigger purge_receipts_immutable/i);
assert.match(operations, /create or replace function public\.consume_rate_limit/i);
assert.match(operations, /create or replace function public\.claim_worker_lease/i);
assert.match(operations, /grant execute on function public\.consume_rate_limit[\s\S]+service_role/i);
assert.match(rateLimitClockFix, /v_now timestamptz := clock_timestamp\(\)/i);
assert.doesNotMatch(rateLimitClockFix, /current_time timestamptz/i);
assert.match(rateLimitClockFix, /INVALID_RATE_LIMIT_ARGUMENTS/i);
assert.match(rateLimitClockFix, /grant execute on function public\.consume_rate_limit[\s\S]+service_role/i);
assert.match(operations, /grant execute on function public\.claim_worker_lease[\s\S]+service_role/i);

console.log("betaSchemaContract.test.ts: all passed");
