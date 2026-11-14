import type { Metadata } from "next";
import { Inter, EB_Garamond } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { siteUrl } from "@/app/lib/deploymentLinks";

const inter = Inter({
    variable: "--font-inter",
    subsets: ["latin"],
});

const ebGaramond = EB_Garamond({
    variable: "--font-eb-garamond",
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
    metadataBase: new URL(siteUrl()),
    title: "Cocoa Legal - AI Legal Platform",
    description:
        "AI-powered legal document analysis, matter strategy, and contract review platform.",
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: siteUrl(),
        siteName: "Cocoa Legal",
        title: "Cocoa Legal - AI Legal Platform",
        description:
            "AI-powered legal document analysis, matter strategy, and contract review platform.",
    },
    twitter: {
        card: "summary",
        title: "Cocoa Legal - AI Legal Platform",
        description:
            "AI-powered legal document analysis, matter strategy, and contract review platform.",
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const themeScript = `
        (function() {
            try {
                var theme = localStorage.getItem("cocoa-theme") === "light" ? "light" : "dark";
                var root = document.documentElement;
                root.dataset.theme = theme;
                root.classList.toggle("dark", theme === "dark");
                root.style.colorScheme = theme;
            } catch (_) {
                document.documentElement.dataset.theme = "dark";
                document.documentElement.classList.add("dark");
                document.documentElement.style.colorScheme = "dark";
            }
        })();
    `;

    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: themeScript }} />
            </head>
            <body
                className={`${inter.variable} ${ebGaramond.variable} font-sans antialiased`}
            >
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
