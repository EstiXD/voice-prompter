import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next, Fraunces } from "next/font/google";
import { Toaster } from "sonner";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/lib/seo";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  style: ["italic", "normal"],
  axes: ["SOFT", "WONK", "opsz"],
});

const atkinson = Atkinson_Hyperlegible_Next({
  variable: "--font-sans",
  subsets: ["latin", "latin-ext"],
  adjustFontFallback: false,
});

const atkinsonMono = Atkinson_Hyperlegible_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: `%s — ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: "EstiXD", url: "https://github.com/EstiXD" }],
  creator: "EstiXD",
  category: "technology",
  keywords: [
    "teleprompter",
    "teleprompter por voz",
    "teleprompter que sigue la voz",
    "teleprompter online gratis",
    "grabar voz sin ruido",
    "prompter reconocimiento de voz",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "es_ES",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0b0a09",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${fraunces.variable} ${atkinson.variable} ${atkinsonMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-ink text-paper">
        <div className="atmosphere" aria-hidden="true" />
        <div className="grain" aria-hidden="true" />
        {children}
        <Toaster
          theme="dark"
          position="top-center"
          offset={16}
          toastOptions={{
            style: {
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-line-strong)",
              color: "var(--color-paper)",
              fontFamily: "var(--font-sans)",
            },
          }}
        />
      </body>
    </html>
  );
}
