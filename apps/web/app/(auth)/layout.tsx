import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "FreeFrame — Auth",
}

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="relative min-h-screen bg-bg-primary flex flex-col items-center justify-center px-4">
      {/* Subtle radial glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-accent/[0.04] blur-[120px]" />
      </div>

      {/* Card */}
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-bg-secondary/50 backdrop-blur-sm p-6 shadow-xl animate-fade-in">
        {children}
      </div>

      {/* Footer */}
      <p className="relative mt-8 text-2xs text-text-tertiary">
        Collaborative media review &amp; approval
      </p>
    </div>
  )
}
