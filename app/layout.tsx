import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import NavLinks from "@/components/nav-links";
import { getCurrentUser } from "@/lib/auth";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Payment & Subscription",
  description: "Pro subscription billing.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The signed-in shell. Auth is replaced by the real Assessment 1 session in
  // production; today it renders a fixed dev user.
  const user = await getCurrentUser();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <header className="border-b border-zinc-200 dark:border-zinc-800">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
            <NavLinks />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {user.name} · {user.email}
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}