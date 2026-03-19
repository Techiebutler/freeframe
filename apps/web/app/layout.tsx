import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'FreeFrame',
  description: 'Collaborative media review and approval platform',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  )
}
