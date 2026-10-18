import type { Metadata } from "next";
import { readPaymentLinkAction } from "@/app/actions";


export async function generateMetadata({
  params,
}: {
  params: Promise<{ ref: string }>;
}): Promise<Metadata> {
  const { ref } = await params;
  const resolution = await readPaymentLinkAction(ref);

  if (!resolution.valid || !resolution.stream) {
    return {
      title: "StreamPay — Payment Link Not Found",
      description: "This StreamPay payment link reference is invalid or could not be resolved on-chain.",
      openGraph: {
        title: "StreamPay — Invalid Payment Link",
        description: "Invalid or expired stream reference.",
      },
    };
  }

  const { stream } = resolution;
  const depositFormatted = (Number(stream.deposit) / 10_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });

  let statusText = "Active Stream";
  if (stream.status.toLowerCase() === "cancelled") {
    statusText = "Cancelled Stream";
  } else if (stream.status.toLowerCase() === "depleted") {
    statusText = "Fully Claimed Stream";
  } else if (Date.now() / 1000 > stream.endTime) {
    statusText = "Completed Stream";
  }

  const title = `${statusText} — ${depositFormatted} Tokens | StreamPay`;
  const description = `Continuous streaming payment on Stellar (Soroban). Total deposit: ${depositFormatted} tokens. Click to connect Freighter and claim accrued funds.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      siteName: "StreamPay",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default function PayLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
