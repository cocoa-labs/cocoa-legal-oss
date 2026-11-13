import "dotenv/config";
import { createServerSupabase } from "../lib/supabase";
import { getEmail } from "../lib/email/store";
import { reconcileEmailAttachments } from "../lib/email/inboundAttachments";
import { installStructuredConsole } from "../lib/logger";

installStructuredConsole();

// Dry run is the default. Only metadata is logged. --after-id resumes a sweep;
// --email-id targets one message. No auto-reply or outbound path is invoked.
async function main() {
  const db = createServerSupabase();
  const apply = process.argv.includes("--apply");
  const emailId = process.argv
    .find((a) => a.startsWith("--email-id="))
    ?.slice(11);
  let cursor = process.argv.find((a) => a.startsWith("--after-id="))?.slice(11);
  const { error: schemaError } = await db
    .from("inbound_email_attachments")
    .select("id")
    .limit(1);
  if (schemaError)
    throw new Error("Apply migration 044 before running attachment repair.");
  do {
    let query = db
      .from("email_messages")
      .select("id")
      .eq("direction", "inbound")
      .order("id")
      .limit(100);
    if (emailId) query = query.eq("id", emailId);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    for (const record of data) {
      const email = await getEmail(db, record.id);
      if (!email) continue;
      if (apply) {
        const rows = await reconcileEmailAttachments(db, {
          ...email,
          attachments_reconciled_at: null,
        });
        const states = rows.reduce<Record<string, number>>((acc, row) => {
          acc[row.status] = (acc[row.status] ?? 0) + 1;
          return acc;
        }, {});
        console.log(JSON.stringify({ email_id: email.id, states }));
      } else
        console.log(
          JSON.stringify({
            email_id: email.id,
            legacy_attachment_count: email.attachments.length,
            action:
              "would reconcile provider parts and retry recoverable files",
          }),
        );
      cursor = email.id;
    }
    console.log(JSON.stringify({ resume_after_id: cursor, applied: apply }));
    if (emailId || data.length < 100) break;
  } while (true);
}
main().catch(() => {
  console.error(
    "Email attachment repair failed. Verify migration 044 and service credentials; resume from the last completed email ID.",
  );
  process.exitCode = 1;
});
