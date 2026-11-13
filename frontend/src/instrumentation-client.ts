import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentryPrivacy";

Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
    environment: process.env.NEXT_PUBLIC_APP_ENV ?? process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_DEPLOYMENT_ID,
    sendDefaultPii: false,
    tracesSampleRate: Number(
        process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.05",
    ),
    beforeSend(event) {
        return scrubSentryEvent(event);
    },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
