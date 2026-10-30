import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Sortd | Intelligent AI Spreadsheet Studio',
  description: 'Clean messy data, audit formulas, and orchestrate financial models with zero spreadsheet lock-in.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full w-full">
      <body
        className={`${geistSans.variable} ${geistMono.variable} h-full w-full m-0 p-0 bg-[#FAFAFA] text-slate-900 antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
