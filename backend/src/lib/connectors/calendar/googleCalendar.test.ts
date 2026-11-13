// backend/src/lib/connectors/calendar/googleCalendar.test.ts
//
// Pins the Google Calendar adapter contract that the routes + agent tools lean
// on: credential gating (isConfigured / ConnectorNotConfiguredError so callers
// degrade to 503), Schema$Event -> CalendarEvent mapping (all-day vs timed,
// Meet conferenceData, recurrence, attendees), and the wire details that make
// invites + Meet actually work (sendUpdates + conferenceDataVersion +
// conferenceData.createRequest). A fake calendar_v3 client is injected so no
// network / real service account is touched.
import assert from "node:assert/strict";
import { GoogleCalendarConnector } from "./googleCalendar";
import { ConnectorNotConfiguredError } from "../types";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

interface Call {
    method: string;
    args: unknown;
}

/**
 * A fake calendar_v3.Calendar that records every call and returns scripted
 * responses. Each namespace method resolves `{ data }` from the provided map.
 */
function makeFakeCalendar(responses: Record<string, unknown>) {
    const calls: Call[] = [];
    const rec = (method: string, data: unknown) => (args: unknown) => {
        calls.push({ method, args });
        return Promise.resolve({ data });
    };
    const client = {
        events: {
            list: rec("events.list", responses["events.list"]),
            get: rec("events.get", responses["events.get"]),
            insert: rec("events.insert", responses["events.insert"]),
            patch: rec("events.patch", responses["events.patch"]),
            delete: rec("events.delete", responses["events.delete"] ?? {}),
        },
        calendarList: {
            list: rec("calendarList.list", responses["calendarList.list"]),
        },
        calendars: {
            insert: rec("calendars.insert", responses["calendars.insert"]),
        },
    };
    return { client, calls };
}

function callOf(calls: Call[], method: string): Call | undefined {
    return calls.find((c) => c.method === method);
}

// A timed event with attendees, a Google Meet link, and a recurrence rule.
const TIMED_EVENT = {
    id: "evt-timed",
    status: "confirmed",
    summary: "Call — opposing counsel",
    description: "Discuss Smith settlement",
    location: "Phone",
    start: { dateTime: "2026-07-20T10:00:00-07:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-07-20T10:30:00-07:00", timeZone: "America/Los_Angeles" },
    attendees: [
        { email: "counsel@firm.com", responseStatus: "accepted", organizer: true },
        { email: "opposing@other.com", responseStatus: "needsAction" },
    ],
    organizer: { email: "counsel@firm.com" },
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
    conferenceData: {
        entryPoints: [
            { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" },
            { entryPointType: "phone", uri: "tel:+1-555-0100" },
        ],
    },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    htmlLink: "https://calendar.google.com/event?eid=evt-timed",
    created: "2026-07-17T00:00:00Z",
    updated: "2026-07-17T00:00:00Z",
};

// An all-day event (start.date, no time).
const ALLDAY_EVENT = {
    id: "evt-allday",
    status: "confirmed",
    summary: "Filing deadline — Acme MSA",
    start: { date: "2026-07-20" },
    end: { date: "2026-07-21" },
};

async function main(): Promise<void> {
    console.log("connectors/calendar/googleCalendar.test.ts");

    const ENV_KEYS = [
        "GMAIL_AGENT_ADDRESS",
        "GOOGLE_SA_CLIENT_EMAIL",
        "GOOGLE_SA_PRIVATE_KEY",
    ] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    const clearEnv = () => {
        for (const k of ENV_KEYS) delete process.env[k];
    };
    const setEnv = () => {
        process.env.GMAIL_AGENT_ADDRESS = "legal@example.com";
        process.env.GOOGLE_SA_CLIENT_EMAIL = "sa@project.iam.gserviceaccount.com";
        process.env.GOOGLE_SA_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----\\n";
    };

    await test("isConfigured() is false with no credentials, true with all three", () => {
        clearEnv();
        assert.equal(new GoogleCalendarConnector().isConfigured(), false);
        setEnv();
        assert.equal(new GoogleCalendarConnector().isConfigured(), true);
        // Partial credentials are still unconfigured.
        delete process.env.GOOGLE_SA_PRIVATE_KEY;
        assert.equal(new GoogleCalendarConnector().isConfigured(), false);
    });

    await test("every method throws ConnectorNotConfiguredError when unconfigured", async () => {
        clearEnv();
        const c = new GoogleCalendarConnector(); // no injected client
        await assert.rejects(
            () => c.listEvents({ calendarId: "primary" }),
            ConnectorNotConfiguredError,
        );
        await assert.rejects(
            () => c.getEvent("primary", "x"),
            ConnectorNotConfiguredError,
        );
        await assert.rejects(
            () =>
                c.createEvent(
                    "primary",
                    { summary: "s", start: { date: "2026-07-20" }, end: { date: "2026-07-21" } },
                    { sendUpdates: "none" },
                ),
            ConnectorNotConfiguredError,
        );
        await assert.rejects(
            () => c.deleteEvent("primary", "x", { sendUpdates: "none" }),
            ConnectorNotConfiguredError,
        );
        await assert.rejects(
            () => c.listCalendars(),
            ConnectorNotConfiguredError,
        );
    });

    await test("listEvents maps timed + all-day, Meet, recurrence, attendees", async () => {
        const { client } = makeFakeCalendar({
            "events.list": {
                items: [TIMED_EVENT, ALLDAY_EVENT],
                nextPageToken: "PAGE2",
                nextSyncToken: null,
            },
        });
        const c = new GoogleCalendarConnector(client as never);
        const res = await c.listEvents({
            calendarId: "primary",
            timeMin: "2026-07-01T00:00:00Z",
            timeMax: "2026-08-01T00:00:00Z",
        });
        assert.equal(res.events.length, 2);
        assert.equal(res.nextPageToken, "PAGE2");

        const timed = res.events[0];
        assert.equal(timed.id, "evt-timed");
        assert.equal(timed.calendarId, "primary");
        assert.equal(timed.allDay, false);
        assert.equal(timed.summary, "Call — opposing counsel");
        assert.equal(timed.start.dateTime, "2026-07-20T10:00:00-07:00");
        assert.deepEqual(timed.recurrence, ["RRULE:FREQ=WEEKLY;COUNT=4"]);
        assert.equal(timed.attendees.length, 2);
        assert.equal(timed.attendees[0].email, "counsel@firm.com");
        assert.equal(timed.attendees[0].organizer, true);
        assert.equal(timed.attendees[1].responseStatus, "needsAction");
        assert.ok(timed.conference, "conference info present");
        assert.equal(
            timed.conference?.uri,
            "https://meet.google.com/abc-defg-hij",
            "the video entry point becomes the Meet uri",
        );

        const allday = res.events[1];
        assert.equal(allday.allDay, true);
        assert.equal(allday.start.date, "2026-07-20");
        assert.deepEqual(allday.attendees, []);
        assert.equal(allday.conference, null);
    });

    await test("createEvent passes sendUpdates + adds Meet via conferenceData when addMeet + attendees", async () => {
        const { client, calls } = makeFakeCalendar({
            "events.insert": TIMED_EVENT,
        });
        const c = new GoogleCalendarConnector(client as never);
        await c.createEvent(
            "primary",
            {
                summary: "Call — opposing counsel",
                start: { dateTime: "2026-07-20T10:00:00-07:00", timeZone: "America/Los_Angeles" },
                end: { dateTime: "2026-07-20T10:30:00-07:00", timeZone: "America/Los_Angeles" },
                attendees: [{ email: "opposing@other.com" }],
                addMeet: true,
            },
            { sendUpdates: "all" },
        );
        const insert = callOf(calls, "events.insert");
        assert.ok(insert, "insert was called");
        const args = insert!.args as {
            calendarId: string;
            sendUpdates: string;
            conferenceDataVersion?: number;
            requestBody: {
                attendees?: unknown[];
                conferenceData?: { createRequest?: { conferenceSolutionKey?: { type?: string } } };
            };
        };
        assert.equal(args.calendarId, "primary");
        assert.equal(args.sendUpdates, "all", "invitations fan out to attendees");
        assert.equal(args.conferenceDataVersion, 1, "required for Meet creation");
        assert.equal(
            args.requestBody.conferenceData?.createRequest?.conferenceSolutionKey?.type,
            "hangoutsMeet",
            "a Meet create request is attached",
        );
        assert.equal((args.requestBody.attendees ?? []).length, 1);
    });

    await test("createEvent omits conferenceData when no Meet requested; sendUpdates none", async () => {
        const { client, calls } = makeFakeCalendar({ "events.insert": ALLDAY_EVENT });
        const c = new GoogleCalendarConnector(client as never);
        await c.createEvent(
            "primary",
            { summary: "Block", start: { date: "2026-07-20" }, end: { date: "2026-07-21" } },
            { sendUpdates: "none" },
        );
        const args = callOf(calls, "events.insert")!.args as {
            sendUpdates: string;
            conferenceDataVersion?: number;
            requestBody: { conferenceData?: unknown };
        };
        assert.equal(args.sendUpdates, "none");
        assert.equal(args.requestBody.conferenceData, undefined, "no Meet on a private event");
    });

    await test("ensureFirmCalendar returns an existing calendar id by summary (no insert)", async () => {
        const { client, calls } = makeFakeCalendar({
            "calendarList.list": {
                items: [
                    { id: "primary", summary: "legal@example.com", primary: true, accessRole: "owner" },
                    { id: "firmcal@group.calendar.google.com", summary: "Coco Legal", accessRole: "owner" },
                ],
            },
        });
        const c = new GoogleCalendarConnector(client as never);
        const id = await c.ensureFirmCalendar("Coco Legal");
        assert.equal(id, "firmcal@group.calendar.google.com");
        assert.equal(callOf(calls, "calendars.insert"), undefined, "no create when one already exists");
    });

    await test("ensureFirmCalendar creates the calendar when absent", async () => {
        const { client, calls } = makeFakeCalendar({
            "calendarList.list": { items: [{ id: "primary", summary: "legal@example.com", primary: true, accessRole: "owner" }] },
            "calendars.insert": { id: "newfirm@group.calendar.google.com" },
        });
        const c = new GoogleCalendarConnector(client as never);
        const id = await c.ensureFirmCalendar("Coco Legal");
        assert.equal(id, "newfirm@group.calendar.google.com");
        const insert = callOf(calls, "calendars.insert");
        assert.ok(insert, "calendars.insert called");
        const body = (insert!.args as { requestBody: { summary: string } }).requestBody;
        assert.equal(body.summary, "Coco Legal");
    });

    // Restore env for any downstream test process reuse.
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }

    console.log("connectors/calendar/googleCalendar.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
