import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/toast";
import RegisterServiceWorker from "@/components/RegisterServiceWorker";
import OfflineBanner from "@/components/OfflineBanner";

export const metadata: Metadata = {
  title: "StreamPay — streaming payments on Stellar",
  description:
    "Create, withdraw, top up and cancel continuous per-second payment streams on the Stellar network.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "StreamPay",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-192.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {/* Skip navigation — WCAG 2.4.1 Bypass Blocks */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <RegisterServiceWorker />
        <OfflineBanner />
        <ToastProvider>
          <div id="main-content">{children}</div>
        </ToastProvider>
      </body>
    </html>
  );
}

