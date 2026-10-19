import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/toast";
import NetworkBadge from "@/components/NetworkBadge";

export const metadata: Metadata = {
  title: "StreamPay — streaming payments on Stellar",
  description:
    "Create, withdraw, top up and cancel continuous per-second payment streams on the Stellar network.",
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
        <ToastProvider>
          <NetworkBadge />
          <div id="main-content">{children}</div>
        </ToastProvider>
      </body>
    </html>
  );
}
