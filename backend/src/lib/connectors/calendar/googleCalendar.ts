/**
 * Google Calendar adapter for the {@link CalendarConnector} contract.
 *
 * Authenticates as the same Google Workspace service account with domain-wide
 * delegation that the Gmail adapter uses, impersonating the agent mailbox
 * (`GMAIL_AGENT_ADDRESS`) — but with its OWN cached JWT and its OWN scope, since
 * a google.auth.JWT is scope-locked at construction and the Gmail client cannot
 * be reused. When credentials are missing the adapter reports
 * {@link GoogleCalendarConnector.isConfigured} = false and every method throws
 * {@link ConnectorNotConfiguredError} so callers degrade gracefully (HTTP 503).
 *
 * Google is the source of truth for event content (recurrence expansion,
 * invite/cancellation delivery, Meet provisioning, timezone). This adapter only
 * translates between Google's `calendar_v3` shapes and our {@link CalendarEvent}
 * DTO.
 */
import { google, calendar_v3 } from "googleapis";
import { randomUUID } from "node:crypto";
import {
    ConnectorNotConfiguredError,
    type CalendarConnector,
    type CalendarDateTime,
    type CalendarEvent,
    type CalendarSummary,
    type ConferenceInfo,
    type EventAttendee,
    type EventInput,
    type ListEventsResult,
    type SendUpdates,
} from "../types";

/** The single broad scope: covers event CRUD, invites, Meet, freebusy, and
 * calendars.insert / acl for firm-calendar provisioning. Must also be added to
 * the service account's domain-wide-delegation allowlist in Workspace Admin. */
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

let cachedAuth: InstanceType<typeof google.auth.JWT> | null = null;
let cachedCalendar: calendar_v3.Calendar | null = null;

/** Normalize a PEM private key that may contain literal "\n" escapes. */
function normalizePrivateKey(key: string): string {
    return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

/** Strip null/undefined so we never send empty keys to Google. */
function cleanDateTime(dt: CalendarDateTime): calendar_v3.Schema$EventDateTime {
    const out: calendar_v3.Schema$EventDateTime = {};
    if (dt.dateTime) out.dateTime = dt.dateTime;
    if (dt.date) out.date = dt.date;
    if (dt.timeZone) out.timeZone = dt.timeZone;
    return out;
}

function mapDateTime(dt: calendar_v3.Schema$EventDateTime | undefined): CalendarDateTime {
    return {
        dateTime: dt?.dateTime ?? null,
        date: dt?.date ?? null,
        timeZone: dt?.timeZone ?? null,
    };
}

function mapAttendees(
    attendees: calendar_v3.Schema$EventAttendee[] | undefined,
): EventAttendee[] {
    return (attendees ?? []).map((a) => ({
        email: a.email ?? "",
        displayName: a.displayName ?? null,
        optional: a.optional ?? undefined,
        responseStatus: a.responseStatus ?? null,
        organizer: a.organizer ?? undefined,
    }));
}

/** Extract the Google Meet link from conferenceData (video entry point) or the
 * legacy hangoutLink fallback. */
function mapConference(e: calendar_v3.Schema$Event): ConferenceInfo | null {
    const video = (e.conferenceData?.entryPoints ?? []).find(
        (ep) => ep.entryPointType === "video",
    );
    const uri = video?.uri ?? e.hangoutLink ?? null;
    if (!uri) return null;
    return { type: "hangoutsMeet", uri };
}

function mapEvent(calendarId: string, e: calendar_v3.Schema$Event): CalendarEvent {
    return {
        id: e.id ?? "",
        calendarId,
        status: e.status ?? "confirmed",
        summary: e.summary ?? "",
        description: e.description ?? null,
        location: e.location ?? null,
        start: mapDateTime(e.start),
        end: mapDateTime(e.end),
        // An all-day event carries start.date (no time); a timed event carries
        // start.dateTime.
        allDay: Boolean(e.start?.date),
        attendees: mapAttendees(e.attendees),
        organizer: e.organizer?.email ? { email: e.organizer.email } : null,
        recurrence: e.recurrence ?? [],
        recurringEventId: e.recurringEventId ?? null,
        conference: mapConference(e),
        htmlLink: e.htmlLink ?? null,
        hangoutLink: e.hangoutLink ?? null,
        created: e.created ?? null,
        updated: e.updated ?? null,
    };
}

/** Is this a Google "not found" error (so getEvent can resolve null)? */
function isNotFound(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: number | string }).code;
    if (code === 404 || code === "404") return true;
    const status = (error as { response?: { status?: number } }).response?.status;
    return status === 404;
}

/**
 * Google Calendar-backed {@link CalendarConnector}. Construct directly (real
 * credentials) or obtain the shared singleton via the connector registry. A
 * `calendar_v3.Calendar` may be injected for tests to bypass auth.
 */
export class GoogleCalendarConnector implements CalendarConnector {
    constructor(private readonly injectedClient?: calendar_v3.Calendar) {}

    /** True only when all three Workspace credentials are present (read live so
     * tests can toggle configuration). */
    isConfigured(): boolean {
        return Boolean(
            process.env.GMAIL_AGENT_ADDRESS &&
                process.env.GOOGLE_SA_CLIENT_EMAIL &&
                process.env.GOOGLE_SA_PRIVATE_KEY,
        );
    }

    /** Lazily construct + cache the delegated JWT auth client. */
    private getAuth(): InstanceType<typeof google.auth.JWT> {
        if (cachedAuth) return cachedAuth;
        if (!this.isConfigured()) throw new ConnectorNotConfiguredError("calendar");
        cachedAuth = new google.auth.JWT({
            email: process.env.GOOGLE_SA_CLIENT_EMAIL as string,
            key: normalizePrivateKey(process.env.GOOGLE_SA_PRIVATE_KEY as string),
            scopes: SCOPES,
            subject: process.env.GMAIL_AGENT_ADDRESS as string,
        });
        return cachedAuth;
    }

    /** Lazily construct + cache the Calendar API client (or the injected one). */
    private getClient(): calendar_v3.Calendar {
        if (this.injectedClient) return this.injectedClient;
        if (cachedCalendar) return cachedCalendar;
        if (!this.isConfigured()) throw new ConnectorNotConfiguredError("calendar");
        cachedCalendar = google.calendar({ version: "v3", auth: this.getAuth() });
        return cachedCalendar;
    }

    async listEvents(opts: {
        calendarId: string;
        timeMin?: string;
        timeMax?: string;
        pageToken?: string;
        syncToken?: string;
        singleEvents?: boolean;
        maxResults?: number;
    }): Promise<ListEventsResult> {
        const client = this.getClient();
        const params: calendar_v3.Params$Resource$Events$List = {
            calendarId: opts.calendarId,
        };
        if (opts.syncToken) {
            // syncToken cannot be combined with timeMin/timeMax/orderBy.
            params.syncToken = opts.syncToken;
        } else {
            if (opts.timeMin) params.timeMin = opts.timeMin;
            if (opts.timeMax) params.timeMax = opts.timeMax;
            params.singleEvents = opts.singleEvents ?? true;
            if (params.singleEvents) params.orderBy = "startTime";
        }
        if (opts.pageToken) params.pageToken = opts.pageToken;
        if (opts.maxResults) params.maxResults = opts.maxResults;

        const res = await client.events.list(params);
        const events = (res.data.items ?? []).map((e) =>
            mapEvent(opts.calendarId, e),
        );
        return {
            events,
            nextPageToken: res.data.nextPageToken ?? null,
            nextSyncToken: res.data.nextSyncToken ?? null,
        };
    }

    async getEvent(
        calendarId: string,
        eventId: string,
    ): Promise<CalendarEvent | null> {
        const client = this.getClient();
        try {
            const res = await client.events.get({ calendarId, eventId });
            return mapEvent(calendarId, res.data);
        } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
        }
    }

    private buildRequestBody(
        input: Partial<EventInput>,
        wantMeet: boolean,
    ): calendar_v3.Schema$Event {
        const body: calendar_v3.Schema$Event = {};
        if (input.summary !== undefined) body.summary = input.summary;
        if (input.description !== undefined && input.description !== null)
            body.description = input.description;
        if (input.location !== undefined && input.location !== null)
            body.location = input.location;
        if (input.start) body.start = cleanDateTime(input.start);
        if (input.end) body.end = cleanDateTime(input.end);
        if (input.attendees)
            body.attendees = input.attendees.map((a) => ({
                email: a.email,
                optional: a.optional,
            }));
        if (input.recurrence) body.recurrence = input.recurrence;
        if (wantMeet) {
            body.conferenceData = {
                createRequest: {
                    requestId: randomUUID(),
                    conferenceSolutionKey: { type: "hangoutsMeet" },
                },
            };
        }
        return body;
    }

    async createEvent(
        calendarId: string,
        input: EventInput,
        opts: { sendUpdates: SendUpdates },
    ): Promise<CalendarEvent> {
        const client = this.getClient();
        const wantMeet = Boolean(
            input.addMeet && (input.attendees?.length ?? 0) > 0,
        );
        const res = await client.events.insert({
            calendarId,
            sendUpdates: opts.sendUpdates,
            conferenceDataVersion: wantMeet ? 1 : undefined,
            requestBody: this.buildRequestBody(input, wantMeet),
        });
        return mapEvent(calendarId, res.data);
    }

    async updateEvent(
        calendarId: string,
        eventId: string,
        input: Partial<EventInput>,
        opts: { sendUpdates: SendUpdates },
    ): Promise<CalendarEvent> {
        const client = this.getClient();
        const wantMeet = Boolean(
            input.addMeet && (input.attendees?.length ?? 0) > 0,
        );
        const res = await client.events.patch({
            calendarId,
            eventId,
            sendUpdates: opts.sendUpdates,
            conferenceDataVersion: wantMeet ? 1 : undefined,
            requestBody: this.buildRequestBody(input, wantMeet),
        });
        return mapEvent(calendarId, res.data);
    }

    async deleteEvent(
        calendarId: string,
        eventId: string,
        opts: { sendUpdates: SendUpdates },
    ): Promise<void> {
        const client = this.getClient();
        await client.events.delete({
            calendarId,
            eventId,
            sendUpdates: opts.sendUpdates,
        });
    }

    async listCalendars(): Promise<CalendarSummary[]> {
        const client = this.getClient();
        const res = await client.calendarList.list();
        return (res.data.items ?? []).map((c) => ({
            id: c.id ?? "",
            summary: c.summary ?? "",
            primary: Boolean(c.primary),
            accessRole: c.accessRole ?? "",
        }));
    }

    async ensureFirmCalendar(displayName: string): Promise<string> {
        const existing = await this.listCalendars();
        const match = existing.find((c) => c.summary === displayName);
        if (match) return match.id;
        const res = await this.getClient().calendars.insert({
            requestBody: {
                summary: displayName,
                timeZone: process.env.CALENDAR_DEFAULT_TIMEZONE || undefined,
            },
        });
        return res.data.id ?? "";
    }
}
