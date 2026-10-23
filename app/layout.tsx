import type { Metadata, Viewport } from "next";
import { Saira_Condensed } from "next/font/google";
import RegisterSW from "@/components/RegisterSW";
import "./globals.css";

const saira = Saira_Condensed({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--font-saira",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Tilt Wheel",
  description: "Turn your phone into a gyro steering wheel for PC racing games.",
  applicationName: "Tilt Wheel",
  appleWebApp: { capable: true, title: "Tilt Wheel", statusBarStyle: "black-translucent" },
  icons: {
    icon: [{ url: "/icons/192", type: "image/png", sizes: "192x192" }],
    apple: [{ url: "/icons/180", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#2E3136",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={saira.variable}>
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
