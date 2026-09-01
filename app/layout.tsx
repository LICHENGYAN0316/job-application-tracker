import type { Metadata, Viewport } from 'next';
import './globals.css';
import PwaRegistration from './pwa-registration';

export const metadata: Metadata = {
  title: '职序 / CAREER RHYTHM',
  description: '把分散的机会、时间与判断，整理成一条可行动的职业路径。',
  applicationName: '职序 / CAREER RHYTHM',
  manifest: '/manifest.webmanifest',
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: '职序',
    statusBarStyle: 'default',
  },
  openGraph: {
    title: '职序 / CAREER RHYTHM',
    description: '把分散的机会、时间与判断，整理成一条可行动的职业路径。',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: '职序 / CAREER RHYTHM',
    description: '把分散的机会、时间与判断，整理成一条可行动的职业路径。',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f5a4f',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
