import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'onesub dashboard',
  description: 'Self-hosted dashboard for onesub — subscriptions + IAP operational state.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
