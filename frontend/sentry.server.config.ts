import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/sentryPrivacy";

Sentry.init({
    dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
    enabled: Boolean(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),
    environment: process.env.APP_ENV ?? process.env.NODE_ENV,
    release: process.env.DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA,
    sendDefaultPii: false,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.05"),
    beforeSend(event) {
        return scrubSentryEvent(event);
    },
});
