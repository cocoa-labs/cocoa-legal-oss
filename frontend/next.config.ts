import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const buildId =
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_COCO_BUILD_ID ||
    process.env.GITHUB_SHA ||
    "development";

const nextConfig: NextConfig = {
    // Docker builds set NEXT_OUTPUT=standalone for a self-contained server;
    // Vercel and other hosts keep the default output.
    output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
    reactCompiler: true,
    env: {
        NEXT_PUBLIC_COCO_BUILD_ID: buildId,
    },
    async rewrites() {
        return [
            {
                source: "/sitemap.xml",
                destination: "/api/sitemap/sitemap.xml",
            },
            {
                source: "/sitemap_:slug.xml",
                destination: "/api/sitemap/sitemap_:slug.xml",
            },
        ];
    },
    skipTrailingSlashRedirect: true,
};

export default withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !process.env.CI,
    sourcemaps: {
        deleteSourcemapsAfterUpload: true,
    },
});
