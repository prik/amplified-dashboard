import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import './globals.css'

const GA_ID = 'G-6QJZ7KT8FX'

const SITE_URL = 'https://ampsrev.xyz'
const SITE_TITLE = 'Amplified Dashboard · Leverage Bot Revenue Stats'
const SITE_DESC =
  'Live revenue, treasury, payouts, and rev share calculator for Amplified, the Telegram bot for 2–10x leverage on crypto and prediction markets.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESC,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Amplified Dashboard',
    title: SITE_TITLE,
    description: SITE_DESC,
    images: [{ url: '/icon-512.png', width: 512, height: 512, alt: 'Amplified' }],
  },
  twitter: {
    card: 'summary',
    title: SITE_TITLE,
    description: SITE_DESC,
    images: ['/icon-512.png'],
  },
  appleWebApp: {
    capable: true,
    title: 'Dashboard',
    statusBarStyle: 'black-translucent',
  },
}

const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'Amplified Dashboard',
      description: SITE_DESC,
      publisher: { '@id': `${SITE_URL}/#org` },
    },
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#org`,
      name: 'Amplified',
      url: SITE_URL,
      logo: `${SITE_URL}/icon-512.png`,
    },
  ],
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0a0a0a',
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Geist:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* Set the theme attribute before paint so we don't flash the wrong
            scheme. Reads localStorage; default = dark. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('amp_theme');if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}`,
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
      </head>
      <body>
        {children}
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
          strategy="afterInteractive"
        />
        <Script id="gtag-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_ID}');
          `}
        </Script>
      </body>
    </html>
  )
}
