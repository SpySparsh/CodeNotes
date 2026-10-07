import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Navbar from '@/components/Navbar';
import QueryProvider from '@/components/providers/QueryProvider';
import { Toaster } from '@/components/ui/sonner';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'CodeNotes AI | Premium YouTube Study Assistant',
  description: 'Generate structured, AI-powered study notes and extract code blocks from technical YouTube videos.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-background text-foreground min-h-screen flex flex-col antialiased selection:bg-cyan-500/30`}>
        <QueryProvider>
          <Navbar />
          <main className="flex-1 flex flex-col items-center w-full">
            {children}
          </main>
          <Toaster richColors position="top-right" />
        </QueryProvider>
      </body>
    </html>
  );
}
