import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'FreeFrame — Auth',
}

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-bg-primary flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="mb-10">
        <img
          src="/logo-full.png"
          alt="FreeFrame"
          width={180}
          height={40}
          className="h-10 w-auto"
        />
      </div>

      {/* Page content */}
      <div className="w-full max-w-sm animate-fade-in">
        {children}
      </div>
    </div>
  )
}
