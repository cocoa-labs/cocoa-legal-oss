/**
 * Connector registry: resolves provider-agnostic connector interfaces to their
 * concrete, cached adapter instances. Route handlers and the operations layer
 * depend on the interfaces here rather than importing adapters directly.
 */
import type { CalendarConnector, EmailConnector } from "./types";
import { GmailConnector } from "./email/gmail";
import { GoogleCalendarConnector } from "./calendar/googleCalendar";

let cachedEmailConnector: EmailConnector | null = null;
let cachedCalendarConnector: CalendarConnector | null = null;

/** Return the shared {@link EmailConnector} singleton (Gmail-backed). */
export function getEmailConnector(): EmailConnector {
    if (!cachedEmailConnector) {
        cachedEmailConnector = new GmailConnector();
    }
    return cachedEmailConnector;
}

/** Return the shared {@link CalendarConnector} singleton (Google Calendar-backed). */
export function getCalendarConnector(): CalendarConnector {
    if (!cachedCalendarConnector) {
        cachedCalendarConnector = new GoogleCalendarConnector();
    }
    return cachedCalendarConnector;
}
