import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Interview Platform",
  description: "Practice interviews with AI, get instant feedback",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className="h-full">
        <body className={`${inter.className} h-full bg-gray-950 text-gray-100 antialiased`}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
