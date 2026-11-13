// backend/src/lib/calendar/reminderEmail.ts
//
// Draft an approval-gated reminder email for a due legal deadline. Mirrors the
// recordings email-draft rails verbatim in shape: createAgentOperation
// (send_email, requiresApproval:true) + createPendingEmail, linked by
// agent_operation_id, so the reminder leaves ONLY via the existing email
// approval card — never auto-sent. Best-effort recipient resolution: the person
// who recorded the deadline. If no recipient can be resolved, it draws no email
// (the scheduler then marks it sent — the deadline is still visible on the
// calendar/agenda). A store fault throws so the scheduler retries next tick.
import type { createServerSupabase } from "../supabase";
import { createAgentOperation } from "../operations";
import { createPendingEmail } from "../email/store";
import { getCalendarConnector } from "../connectors/registry";
import { resolveAuthUsers } from "../userLookup";
import type { CalendarEventMeta } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

export async function draftDeadlineReminder(
    db: Db,
    meta: CalendarEventMeta,
): Promise<void> {
    // Resolve the recipient (the person who recorded the deadline). Best-effort.
    let to: string[] = [];
    try {
        const resolved = await resolveAuthUsers(db as never, {
            userIds: [meta.created_by_user_id],
        });
        const email = resolved.userById.get(meta.created_by_user_id)?.email;
        if (email) to = [email];
    } catch {
        // Auth admin unavailable — treat as no recipient.
    }
    if (to.length === 0) return; // nothing to send; scheduler marks it sent

    // Fetch the event title (best-effort; fall back to a generic label).
    let title = "an upcoming deadline";
    try {
        const connector = getCalendarConnector();
        if (connector.isConfigured()) {
            const event = await connector.getEvent(
                meta.calendar_id,
                meta.google_event_id,
            );
            if (event?.summary) title = event.summary;
        }
    } catch {
        // keep the default title
    }

    const dueDate = meta.deadline_at ? new Date(meta.deadline_at) : null;
    const whenLabel =
        dueDate && !Number.isNaN(dueDate.getTime())
            ? dueDate.toLocaleDateString("en-US", {
                  weekday: "long",
                  year: "numeric",
                  month: "long",
                  day: "numeric",
              })
            : "";
    const typeLabel = (meta.deadline_type ?? "deadline").replace(/_/g, " ");
    const subject = `Reminder: ${title}${whenLabel ? ` (${whenLabel})` : ""}`;
    const bodyText = [
        `This is a reminder about an upcoming ${typeLabel}.`,
        "",
        `${title}${whenLabel ? ` — due ${whenLabel}` : ""}`,
        meta.reminder_lead_days
            ? `\nYou asked to be reminded ${meta.reminder_lead_days} day${meta.reminder_lead_days === 1 ? "" : "s"} ahead.`
            : "",
        "\n— Quill",
    ]
        .filter((line) => line !== undefined)
        .join("\n");

    const operation = await createAgentOperation({
        db,
        userId: meta.created_by_user_id,
        projectId: meta.project_id ?? null,
        toolName: "send_email",
        actionType: "send_email",
        mutating: true,
        requiresApproval: true,
        arguments: { to, subject },
        metadata: {
            summary: `Deadline reminder: ${title}`,
            deadline_meta_id: meta.id,
        },
    });

    const email = await createPendingEmail(db, {
        userId: meta.created_by_user_id,
        projectId: meta.project_id ?? null,
        agentOperationId: operation?.id ?? null,
        to,
        subject,
        bodyText,
        attachments: [],
    });
    if (!email) {
        // Email store unavailable → throw so the scheduler retries next tick
        // rather than losing the reminder.
        throw new Error("Email store unavailable — reminder not drafted.");
    }
}
