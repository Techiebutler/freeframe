"use client";

/**
 * V3 part C: the page an agent opens in a person's browser to hand a delivery in. Signed-in Aditor staff see what goes
 * out (the videos, the text, who it is for) and press one button; the clean client link (V3 A) appears to copy and
 * send. The agent prepares, a person signs: the API refuses agents (403) and anyone who is not staff.
 */
import * as React from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Check, Copy, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { shortName } from "@/lib/handin-sign";

type HandinFile = { id: string; name: string; url: string | null; thumbnail_url: string | null };
type Handin = {
  id: string; state: "prepared" | "signed"; title: string; recipient: string; client_text: string; files: HandinFile[];
  signed_by: string | null; signed_at: string | null; client_url: string | null;
};

/** The only sentences on the page: what went wrong and what to do. */
const PROBLEM: Record<string, string> = {
  link_expired: "This link expired. Ask the agent for a new one.",
  link_replaced: "A newer link replaced this one. Open the latest link from the agent.",
  staff_only: "Only Aditor staff can sign a hand-in.",
  agents_may_not_sign: "Only a person can sign a hand-in.",
  not_found: "This hand-in does not exist.",
};

export default function HandinSignPage() {
  const { id } = useParams<{ id: string }>();
  const t = useSearchParams().get("t") ?? "";
  const [handin, setHandin] = React.useState<Handin | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [signing, setSigning] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const qs = `?t=${encodeURIComponent(t)}`;
  const fail = (e: unknown) => setProblem(PROBLEM[e instanceof ApiError ? e.detail : ""] ?? "That did not work. Try again.");

  React.useEffect(() => { api.get<Handin>(`/handins/${id}${qs}`).then(setHandin, fail); }, [id, qs]); // eslint-disable-line react-hooks/exhaustive-deps

  const sign = async () => {
    setSigning(true);
    try { setHandin(await api.post<Handin>(`/handins/${id}/sign${qs}`)); } catch (e) { fail(e); } finally { setSigning(false); }
  };
  const copy = async () => {
    if (!handin?.client_url) return;
    try { await navigator.clipboard.writeText(handin.client_url); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* the link stays visible to copy by hand */ }
  };

  if (problem) return <main className="flex min-h-dvh items-center justify-center bg-bg-primary px-4"><p role="alert" className="max-w-sm text-center text-base text-text-primary">{problem}</p></main>;
  if (!handin) return <main className="flex min-h-dvh items-center justify-center bg-bg-primary"><Loader2 className="h-6 w-6 animate-spin text-text-tertiary" aria-label="Loading" /></main>;

  const signed = handin.state === "signed";
  return (
    <main className="min-h-dvh bg-bg-primary text-text-primary">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-32 pt-8 md:px-8 md:pb-12">
        <header className="flex flex-col gap-1">
          <p className="text-sm text-text-tertiary">{handin.recipient}</p>
          <h1 className="text-2xl font-semibold leading-tight md:text-3xl">{handin.title}</h1>
        </header>

        {/* Signed: the result goes first, where a phone sees it without scrolling. */}
        {signed ? (
          <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-4" aria-live="polite">
            <p className="flex items-center gap-2 text-sm text-status-success"><Check className="h-4 w-4" aria-hidden="true" />Signed by {handin.signed_by}{handin.signed_at ? ` · ${new Date(handin.signed_at).toLocaleString()}` : ""}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input readOnly value={handin.client_url ?? ""} aria-label="Client link" onFocus={(e) => e.currentTarget.select()} className="h-11 min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-3 text-sm" />
              <Button size="lg" onClick={copy}>{copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}{copied ? "Copied" : "Copy link"}</Button>
            </div>
          </section>
        ) : null}

        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Videos">
          {handin.files.map((f) => (
            <li key={f.id} className="flex min-w-0 flex-col gap-2">
              <div className="aspect-[9/16] overflow-hidden rounded-lg bg-bg-tertiary">
                {f.url ? <video src={f.url} poster={f.thumbnail_url ?? undefined} controls playsInline preload="none" className="h-full w-full object-cover" /> : null}
              </div>
              <p className="truncate text-sm text-text-secondary" title={f.name}>{shortName(f.name, handin.title)}</p>
            </li>
          ))}
        </ul>

        {handin.client_text ? <blockquote className="whitespace-pre-line rounded-lg border border-border bg-bg-secondary p-4 text-base leading-relaxed">{handin.client_text}</blockquote> : null}

        {signed ? null : (
          <div className="fixed inset-x-0 bottom-0 border-t border-border bg-bg-primary/95 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0">
            <Button size="lg" className="w-full md:w-auto md:min-w-64" disabled={signing} onClick={sign}>
              {signing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Sign and send
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
