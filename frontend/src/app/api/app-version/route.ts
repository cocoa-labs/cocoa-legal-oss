import { NextResponse } from "next/server";

import { APP_VERSION_PROTOCOL } from "@/app/lib/appVersionState";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
    return NextResponse.json(
        {
            protocol: APP_VERSION_PROTOCOL,
            build_id:
                process.env.NEXT_PUBLIC_COCOA_BUILD_ID?.trim() || "development",
        },
        {
            headers: {
                "Cache-Control":
                    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
                Pragma: "no-cache",
                Expires: "0",
                "CDN-Cache-Control": "no-store",
                "Vercel-CDN-Cache-Control": "no-store",
            },
        },
    );
}
