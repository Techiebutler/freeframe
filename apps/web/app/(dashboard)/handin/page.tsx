"use client";

/**
 * Hand in a video: one route instead of two.
 *
 * Today an editor uploads to FreeFrame and, separately, hands the same file to
 * review.aditor.ai for a craft review. This page does both from one screen and
 * gives back the share link to post.
 *
 * ADDITIVE BY CONSTRUCTION. Nothing here removes or restricts the existing
 * route - an editor who ignores this page uploads exactly as before. It lives
 * under (dashboard), so FreeFrame's own middleware already requires a signed-in
 * editor before the page renders; there is no second login. It renders at all
 * only when NEXT_PUBLIC_REVIEW_GATE_URL is set, so a build that is not Aditor's
 * does not grow a route pointing at Aditor's review service.
 *
 * The share link is created in code with `permission: comment` and
 * `allow_download: true`. Those are not defaults worth leaving to a dialog:
 * without commenting the review cannot be posted at all, and without downloads
 * only the streaming copy exists, which cannot be analysed. An editor should
 * not have to know that.
 *
 * On the one rule that governs the result, see the header of
 * `components/handin/handin-result.tsx`.
 */

import * as React from "react";
import { PartsHandin } from "@/components/handin/parts-handin";
import { partsEnabled } from "@/lib/iterations";
import Link from "next/link";
import useSWR from "swr";
import { Check, Film, FolderOpen, Loader2, Upload } from "lucide-react";
import { SavedChecklist, ChecklistPanel, useChecklistPreparation } from "@/components/v2/checklist";
import { prepareChecklist, uniqueChecklistWorkspace } from "@/lib/checklist";
import { api, ApiError } from "@/lib/api";
import {
  GATE_BASE,
  fetchReview,
  fetchDeliveryStatus,
  isHandinConfigured,
  lookUpCard,
  handinCardFromSearch,
  type GateCard,
  type GateReview,
  type DeliveryStatus,
  type OpenBlocker,
} from "@/lib/handin";
import { HandinResult, ProcessingFailureNotice } from "@/components/handin/handin-result";
import { computeStages, isTerminalReview, type FileFacts, type ReviewFacts, type StageView } from "@/lib/stages";
import { DeliverButton } from "@/components/handin/deliver-button";
import { HandinHeld } from "@/components/handin/handin-held";
import { WorkspacePicker, type WorkspaceChoice } from "@/components/handin/workspace-picker";
import { UploadZone } from "@/components/upload/upload-zone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUploadStore } from "@/stores/upload-store";
import { useAuthStore } from "@/stores/auth-store";
import { usePageTitle } from "@/hooks/use-page-title";
import type { Project } from "@/types";

/** How often to ask the gate for the review once an asset exists. */
const REVIEW_POLL_MS = 5000;

/** How often to re-check whether the hand-in has been delivered (or is still held/reviewing). */
const DELIVERY_POLL_MS = 5000;

/** Human file size for the selected-file chip. */
function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Phase = "form" | "working" | "done";

function CompleteHandinPage({ onStarted }: { onStarted?: () => void } = {}) {
  usePageTitle("Hand in");

  const [cardUrl, setCardUrl] = React.useState("");
  const [card, setCard] = React.useState<GateCard | null>(null);
  const [lookingUp, setLookingUp] = React.useState(false);
  // A hand-in can be one cut or every cut for a card at once. They all go into
  // one folder and share one link; the reviewer reviews each on its own.
  const [files, setFiles] = React.useState<File[]>([]);
  const [workspace, setWorkspace] = React.useState<WorkspaceChoice | null>(null);
  const [phase, setPhase] = React.useState<Phase>("form");
  const [step, setStep] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const [shareUrl, setShareUrl] = React.useState<string | null>(null);
  const [editorUrl, setEditorUrl] = React.useState<string | null>(null);
  const [shareToken, setShareToken] = React.useState<string | null>(null);
  // Where the just-created folder lives in FreeFrame, so the editor can open it after handing in.
  const [folderHref, setFolderHref] = React.useState<string | null>(null);
  // The DELIVERY state of this hand-in - delivered / held / reviewing. Never gates the link.
  const [delivery, setDelivery] = React.useState<DeliveryStatus | null>(null);
  // One entry per handed-in video, in upload order, plus its review as it lands.
  const [assets, setAssets] = React.useState<{ id: string; name: string }[]>([]);
  const [reviews, setReviews] = React.useState<Record<string, GateReview>>({});

  /** Add newly picked files, skipping ones already chosen (same name and size). */
  const addFiles = React.useCallback((selected: File[]) => {
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...selected.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  }, []);

  const startUpload = useUploadStore((s) => s.startUpload);

  // Redraw the minutes in the stage strip without asking anybody anything.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // The upload store keeps tracking each file's processing status after this page's own
  // `waitForUpload` has already resolved (it resolves as soon as processing STARTS, not when it
  // finishes) - the global SSE bridge + poll fallback keep it current. So a transcode that fails
  // after this page has moved to "done" still shows up here, by asset id.
  const uploadFiles = useUploadStore((s) => s.files);
  const processingFailures = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of uploadFiles) {
      if (f.status === "failed" && f.assetId) map[f.assetId] = f.error || "Processing failed";
    }
    return map;
  }, [uploadFiles]);

  /**
   * Where each handed-in video is: Upload, Processing, Reviewing, Done. Joins what this browser's
   * upload tracker knows (the file) with what the review tool says (the review). A review that
   * could not be reached is "unavailable", never a review quietly still running.
   */
  const stageFor = (assetId: string): StageView => {
    const up = uploadFiles.find((f) => f.assetId === assetId);
    const file: FileFacts = !up
      ? "unknown"
      : up.status === "complete"
        ? "ready"
        : up.status === "processing"
          ? "processing"
          : up.status === "failed"
            ? "failed"
            : up.status === "uploading" || up.status === "pending"
              ? "uploading"
              : "unknown";
    const r = reviews[assetId];
    const review: ReviewFacts = !r
      ? null
      : r.state === "pending" && r.unreachable
        ? "unreachable"
        : (r.stage ??
          (r.state === "ready"
            ? { stage: "done", clean: !(r.worthFixing ?? []).length && !(r.niceToHave ?? []).length }
            : { stage: "waiting" }));
    return computeStages({ file, startedAt: up?.createdAt, review, now: nowMs });
  };
  // Who is delivering, so the delivery comment carries their name. FreeFrame already knows the
  // signed-in editor; the editor never types it.
  const user = useAuthStore((s) => s.user);
  // Only an admin (or the brand-onboarding automation) creates a workspace. Editors file into an
  // existing brand workspace - a per-card workspace is what left a share link pointing at nothing.
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  const checklist = useChecklistPreparation(user && user.is_staff !== false && workspace?.kind === "existing" ? workspace.id : null, cardUrl);
  const checklistConflict = checklist.conflict;

  // The workspaces the editor can file this hand-in into. The card can't be mapped to a project
  // automatically (projects carry no brand), so the editor picks - pre-filled when we can guess.
  const { data: projects } = useSWR<Project[]>("/projects", (k: string) => api.get<Project[]>(k));
  // Only brand WORKSPACES are offered - not the ~100 per-card junk projects that piled up. A brand
  // with no workspace yet shows "ask an admin" in the picker, which is correct: a new brand is
  // onboarded by an admin / the onboarding automation, never spun up per hand-in.
  const workspaceOptions = React.useMemo(
    () =>
      (projects ?? [])
        .filter((p) => p.is_workspace)
        .map((p) => ({ id: p.id, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  // Best-effort pre-select: match the card's brand/name to a "- Workspace" project. The editor
  // chooses explicitly when more than one workspace matches.
  React.useEffect(() => {
    if (workspace || !projects?.length || !card) return;
    const hit = uniqueChecklistWorkspace(projects, String(card.brand || ""), String(card.name || ""));
    if (hit) setWorkspace({ kind: "existing", id: hit.id, name: hit.name });
  }, [projects, card, workspace]);

  // Look the card up on blur or paste. The editor types neither name nor brand;
  // both come back from the card so the project cannot be misfiled by a typo.
  const lookupSequence = React.useRef(0);
  const runLookup = React.useCallback(async (url: string) => {
    const sequence = ++lookupSequence.current;
    const trimmed = url.trim();
    if (!trimmed) {
      setCard(null);
      setLookingUp(false);
      return;
    }
    setLookingUp(true);
    try {
      const result = await lookUpCard(trimmed);
      if (sequence === lookupSequence.current) setCard(result);
    } finally {
      if (sequence === lookupSequence.current) setLookingUp(false);
    }
  }, []);

  React.useEffect(() => {
    if (!isHandinConfigured()) return;
    const initialCard = handinCardFromSearch(window.location.search);
    if (!initialCard) return;
    setCardUrl(initialCard);
    void runLookup(initialCard);
    return () => { lookupSequence.current++; };
  }, [runLookup]);

  /**
   * Poll the gate for the review of every handed-in video, until each is ready.
   *
   * This effect owns the reviews and nothing else. It never touches `shareUrl`,
   * so no answer it receives - pending, ready, or a total failure to parse -
   * can affect whether the link is on screen.
   */
  React.useEffect(() => {
    if (!assets.length) return;
    let cancelled = false;

    async function tick() {
      const results = await Promise.all(
        assets.map(async (a) => [a.id, await fetchReview(a.id)] as const),
      );
      if (cancelled) return true;
      setReviews((prev) => {
        const next = { ...prev };
        for (const [id, r] of results) next[id] = r;
        return next;
      });
      // Done only when every review is final: a `ready` whose stage is still `reading` is an
      // EARLIER version's notes while the new one is being read, so keep asking.
      return results.every(([, r]) => r.state === "ready" && isTerminalReview(r.stage));
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    void tick().then((allReady) => {
      if (cancelled || allReady) return;
      timer = setInterval(async () => {
        const done = await tick();
        if (done && timer) clearInterval(timer);
      }, REVIEW_POLL_MS);
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [assets]);

  /**
   * Poll the delivery state until the hand-in is delivered.
   *
   * Delivery is the ONLY thing gated on the review: it waits until nothing mandatory is open, and
   * fires by itself once the editor's fix or objection clears the last blocker - so we keep polling
   * through "held" and "reviewing", not only until the first answer. This never touches the link.
   */
  React.useEffect(() => {
    if (phase !== "done" || !shareToken) return;
    let cancelled = false;

    async function tick(): Promise<boolean> {
      const s = await fetchDeliveryStatus(shareToken!);
      if (cancelled) return true;
      setDelivery(s);
      return s.state === "delivered";
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    void tick().then((done) => {
      if (cancelled || done) return;
      timer = setInterval(async () => {
        if (await tick() && timer) clearInterval(timer);
      }, DELIVERY_POLL_MS);
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [phase, shareToken]);

  /**
   * Two-pass review: the hold is decided at pass 1, while the taste read still runs. The moment it turns
   * `held`, bring the panel (Must-fix + "Open revision") into view - once, so later polls that only add
   * Guidance never yank the page while the editor reads. The folder link above hides while held: the
   * panel's button already goes there or deeper, and two look-alike actions would compete.
   */
  const heldRef = React.useRef<HTMLDivElement>(null);
  const isHeld = delivery?.state === "held";
  React.useEffect(() => {
    if (!isHeld) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    heldRef.current?.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "start" });
  }, [isHeld]);

  /**
   * Wait for the bytes to land, then hand back the asset id.
   *
   * The store records `assetId` as soon as the upload is initiated, but a link
   * to a half-uploaded file is a promise we cannot keep - so this waits for the
   * upload itself to finish (processing may still be running, which is fine:
   * the link works and the review is what waits on the transcode).
   */
  function waitForUpload(fileId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = (state: ReturnType<typeof useUploadStore.getState>) => {
        const entry = state.files.find((f) => f.id === fileId);
        if (!entry) return;
        if (entry.status === "failed") {
          unsubscribe();
          reject(new Error(entry.error ?? "Upload failed"));
        } else if (entry.status === "cancelled") {
          unsubscribe();
          reject(new Error("Upload cancelled"));
        } else if (
          (entry.status === "processing" || entry.status === "complete") &&
          entry.assetId
        ) {
          unsubscribe();
          resolve(entry.assetId);
        }
      };
      const unsubscribe = useUploadStore.subscribe(check);
      check(useUploadStore.getState());
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!files.length || !workspace) return;

    onStarted?.();
    setPhase("working");
    setError(null);

    try {
      if (checklistConflict) throw checklistConflict;
      // 1. The workspace project: an existing brand workspace, or a new one the editor named.
      //    Aditor is one team across every brand, so a hand-in belongs to the team (project_type
      //    "team"), not to whoever uploaded it.
      setStep(workspace.kind === "create" ? "Creating the workspace" : "Opening the workspace");
      let projectId: string;
      let projectName: string;
      if (workspace.kind === "create") {
        const p = await api.post<Project>("/projects", { name: workspace.name, project_type: "team" });
        projectId = p.id;
        projectName = p.name;
      } else {
        projectId = workspace.id;
        projectName = workspace.name;
      }

      // 2. File the hand-in as a FOLDER in that workspace, with the card link in its description.
      //    That description is load-bearing: it is how the review resolves the brand and briefing,
      //    and creating the folder is what registers it with Auto Review (a standing folder link
      //    and arming happen server-side here). One folder per hand-in, one brand per workspace.
      //
      //    REUSE the card's folder if it already exists in this workspace. Re-handing-in the same
      //    card (a V2, or a retry after an error) must land in the SAME folder, so its one share
      //    link keeps working - otherwise every attempt spawned a new folder (7+ piled up on one
      //    card) and the link an editor had pointed at an older, emptier one.
      setStep("Filing the hand-in");
      // Name the folder after the Trello card, reliably. The card is normally resolved already (on
      // paste/blur), but if it isn't - a flaky lookup, or a paste that didn't fire a blur - resolve
      // it now rather than falling back to a hook's file name. A folder called "Hook 1-a.mp4" is
      // exactly the "which card is this?" confusion we are removing; the file-name fallback is only
      // for when the card genuinely cannot be read.
      const resolvedCard =
        card?.name?.trim() ? card : await lookUpCard(cardUrl.trim()).catch(() => card);
      const folderName = (resolvedCard?.name ?? "").trim() || files[0].name;
      const cardKey = (cardUrl.match(/trello\.com\/c\/([A-Za-z0-9]+)/i)?.[1] || "").toLowerCase();
      const prepared = checklist.data || await prepareChecklist(projectId, cardUrl.trim()).catch((error) => {
        if (error instanceof ApiError && error.status === 409) {
          checklist.rememberConflict(error);
          throw error;
        }
        return undefined;
      });
      const existingFolder = cardKey
        ? await api
            .get<{ id: string; description?: string | null }[]>(`/projects/${projectId}/folders`)
            .then((fs) => fs.find((f) => (f.description || "").toLowerCase().includes(`/c/${cardKey}`) || (!!prepared?.trello_card_id && (f.description || "").includes(`/c/${prepared.trello_card_id}`))))
            .catch(() => undefined)
        : undefined;
      const folder =
        (!prepared && existingFolder) ||
        (await api.post<{ id: string }>(`/projects/${projectId}/folders`, {
          name: folderName,
          parent_id: null,
          description: prepared?.trello_card_id ? `https://trello.com/c/${prepared.trello_card_id}` : cardUrl.trim(),
          ...(prepared ? { checklist_binding_id: prepared.id, ...(existingFolder ? { existing_folder_id: existingFolder.id } : {}) } : {}),
        }));

      // Verify the assignment before any file side effect, including checklist outages.
      // adopt=false: verifying must never submit files already sitting in a reused folder.
      await api.post(`/folders/${folder.id}/editor-request?adopt=false`, {});

      // 3. Every video goes INTO that one folder. They upload together; the
      //    reviewer picks up each asset on its own as it finishes transcoding,
      //    so all of them get reviewed, not just the first.
      setStep(files.length > 1 ? `Uploading ${files.length} videos` : "Uploading");
      const uploadIds = files.map((f) => startUpload(f, projectId, f.name, projectName, folder.id));
      let uploaded: { id: string; name: string }[];
      try {
        uploaded = await Promise.all(
          uploadIds.map(async (uploadId, i) => ({ id: await waitForUpload(uploadId), name: files[i].name })),
        );
      } catch (uploadError) {
        // One file failed or was cancelled: stop the whole hand-in. Cancel the siblings still on the way and
        // do NOT ask for the review link. A sibling that already arrived was handed in by /upload/complete
        // and stays on the card, so say so rather than claim nothing was submitted.
        const { files: current, cancelUpload } = useUploadStore.getState();
        const hasArrived = (uid: string) => {
          const status = current.find((f) => f.id === uid)?.status;
          return status === "processing" || status === "complete";
        };
        uploadIds.filter((uid) => !hasArrived(uid)).forEach((uid) => cancelUpload(uid));
        const arrived = uploadIds.filter(hasArrived).length;
        const outcome = arrived
          ? `${arrived} ${arrived === 1 ? "file had" : "files had"} already arrived and ${arrived === 1 ? "stays" : "stay"} on this card - add the rest and hand in again.`
          : "Nothing was submitted - add all your files and hand in again.";
        throw new Error(
          uploadError instanceof Error && uploadError.message === "Upload cancelled"
            ? `Hand-in cancelled. ${outcome}`
            : `${uploadError instanceof Error ? uploadError.message : "Upload failed"}. ${outcome}`,
        );
      }

      // The API binds the existing folder and versions to the native editor.
      // Canonical origins are server-owned: Whop's iframe origin is not a share URL.
      setStep("Getting the review link");
      const request = await api.post<{ url: string; share_url: string; review_share_token: string }>(
        `/folders/${folder.id}/editor-request`, {},
      );
      const token = request.review_share_token;
      const url = request.share_url;
      setEditorUrl(request.url);

      // 5. Deliver to the Trello card - GATED ON THE REVIEW (Shawn+Saskia, 2026-09-14). This records
      //    the intent to deliver (with the editor's name) and posts the @aditorteam1 comment now IF
      //    the review is already clear. If a mandatory finding is still open it is HELD - the editor
      //    fixes a V2 or objects to a wrong note - and if the review is still running it delivers
      //    automatically once it comes back clear. The link is already on screen regardless; only the
      //    automatic Trello delivery waits. The deliver-status poll below keeps this fresh.
      try {
        const dr = await fetch(`${GATE_BASE}/api/gate/deliver`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ share_token: token, editor_name: user?.name || "" }),
        });
        const dj = (await dr.json().catch(() => ({}))) as {
          posted?: boolean; reason?: string; openBlockers?: OpenBlocker[];
        };
        if (dr.ok && (dj.posted || dj.reason === "already-delivered")) setDelivery({ state: "delivered" });
        else if (dj.reason === "held") setDelivery({ state: "held", openBlockers: dj.openBlockers ?? [] });
        else if (dj.reason === "reviewing") setDelivery({ state: "reviewing" });
        // else leave delivery null -> the manual fallback button shows.
      } catch {
        /* delivery is best effort; the poll + manual button below cover a failure */
      }

      setShareUrl(url);
      setShareToken(token);
      setFolderHref(`/projects/${projectId}?folder=${folder.id}`);
      setAssets(uploaded);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("form");
    }
  }

  if (!isHandinConfigured()) {
    // eslint-disable-next-line no-console
    console.error(
      "Hand-in page rendered with no review gate configured (NEXT_PUBLIC_REVIEW_GATE_URL is empty in this build).",
    );
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-lg font-medium text-text-primary">Hand in</h1>
        <p className="mt-2 text-sm text-text-tertiary">
          Hand-in isn&apos;t available right now. Try feedback.aditor.ai directly, or contact
          support.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-lg font-medium text-text-primary">Hand in</h1>
      <p className="mt-1 text-sm text-text-tertiary">
        Upload your cut - or all the cuts for this card at once.{" "}
        <strong className="text-text-secondary">
          Every file you add here goes in one submission, so add all your versions and hooks before you
          hand in.
        </strong>{" "}
        Open each review in the video player,
        and once nothing mandatory is open it&apos;s delivered to your Trello card automatically - one
        link posted there with your name, the card marked done. If a note is wrong, reply to it and it
        gets checked.
      </p>

      {phase === "done" && shareUrl ? (
        <div className="mt-6">
          {/* Link first, reviews second. See handin-result.tsx. One link over
              every video; one review per video, labelled when there are several. */}
          <HandinResult
            shareUrl={shareUrl}
            editorUrl={editorUrl ?? undefined}
            reviews={assets.map((a) => ({
              label: assets.length > 1 ? a.name : undefined,
              review: reviews[a.id] ?? null,
              failedDetail: processingFailures[a.id],
              stageView: stageFor(a.id),
            }))}
          />
          {/* A way back into FreeFrame itself: open the folder these videos landed in, inside the
              brand workspace. The share link above is for the client; this is for the editor. */}
          {folderHref && delivery?.state !== "held" && (
            <Link
              href={folderHref}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm text-text-primary hover:bg-bg-hover"
            >
              <FolderOpen className="h-4 w-4" />
              Open folder in FreeFrame
            </Link>
          )}
          {/* Delivery to the Trello card is automatic AND gated on the review (Shawn+Saskia
              2026-09-14): it fires when nothing mandatory is open, is HELD while a blocker stands,
              and delivers by itself once a fix or an objection clears it. The link above is shown
              regardless - the gate is on the delivery, never on the link. */}
          {delivery?.state === "delivered" ? (
            <section
              data-testid="handin-delivered"
              className="mt-6 flex items-center gap-2 rounded-lg border border-border bg-bg-secondary p-4 text-sm text-text-primary"
            >
              <Check className="h-4 w-4 text-green-500" />
              Delivered to the Trello card, with your name.
            </section>
          ) : delivery?.state === "held" ? (
            <div ref={heldRef}>
              <HandinHeld blockers={delivery.openBlockers} showNames={assets.length > 1} folderHref={folderHref} />
            </div>
          ) : delivery?.state === "reviewing" || delivery?.state === "clear" ? (
            <section
              data-testid="handin-reviewing"
              className="mt-6 flex items-center gap-2 rounded-lg border border-border bg-bg-secondary p-4 text-sm text-text-secondary"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              {delivery.state === "clear"
                ? "Review is clean - delivering to the Trello card now."
                : "The review is still running - this delivers to the Trello card automatically once it is clear."}
            </section>
          ) : (
            /* Delivery never registered (the request did not go through). The manual button is the
               fallback; it hits the same gated endpoint, so it too respects the review. */
            shareToken && (
              <DeliverButton
                shareToken={shareToken}
                editorName={user?.name}
                editorOnCard={card?.editorOnCard}
              />
            )
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-6 space-y-5 rounded-xl border border-border bg-bg-secondary p-6">
          <div>
            <label
              htmlFor="card-url"
              className="text-sm font-medium text-text-primary"
            >
              Trello card link
            </label>
            <Input
              id="card-url"
              value={cardUrl}
              placeholder="https://trello.com/c/..."
              onChange={(e) => {
                lookupSequence.current++;
                setCard(null);
                setLookingUp(false);
                setCardUrl(e.target.value);
              }}
              onBlur={(e) => void runLookup(e.target.value)}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData("text");
                if (!pasted) return;
                e.preventDefault();
                setCardUrl(pasted);
                setCard(null);
                void runLookup(pasted);
              }}
              className="mt-1.5"
            />

            {lookingUp && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-text-tertiary">
                <Loader2 className="h-3 w-3 animate-spin" />
                Looking up the card
              </p>
            )}

            {/* Confirmation, so the editor can see the right card was found.
                Name and brand are shown, never typed. */}
            {!lookingUp && card && (card.name || card.brand) && (
              <div
                data-testid="card-confirmation"
                className="mt-2 rounded-md border border-border bg-bg-tertiary px-3 py-2"
              >
                {card.name && (
                  <p className="text-sm text-text-primary">{card.name}</p>
                )}
                {card.brand && (
                  <p className="text-xs text-text-tertiary">{card.brand}</p>
                )}
                {card.hasBriefing === false && (
                  <p className="mt-1 text-xs text-text-tertiary">
                    No briefing found on this card. You can still upload - the
                    review will say what it could not check.
                  </p>
                )}
              </div>
            )}

            {!lookingUp && card?.note && (
              <p className="mt-2 text-xs text-text-tertiary">{card.note}</p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium text-text-primary">Workspace</label>
            <p className="mt-0.5 text-xs text-text-tertiary">
              The brand this hand-in belongs to. It&apos;s filed as a folder inside it - search, or
              type a new name to create one.
            </p>
            <WorkspacePicker
              projects={workspaceOptions}
              value={workspace}
              onChange={setWorkspace}
              allowCreate={isSuperAdmin}
            />
          </div>

          <div>
            <label className="text-sm font-medium text-text-primary">Video files</label>
            <p className="mt-0.5 text-xs text-text-tertiary">
              Hand in one cut, or all the cuts for this card at once - each gets its own review.
            </p>
            {files.length > 0 && (
              <ul className="mt-1.5 space-y-2">
                {files.map((f, i) => (
                  <li
                    key={`${f.name}:${f.size}:${i}`}
                    className="flex items-center justify-between rounded-lg border border-border bg-bg-tertiary px-3 py-2.5"
                  >
                    <span className="mr-2 flex min-w-0 items-center gap-2 text-sm text-text-primary">
                      <Film className="h-4 w-4 shrink-0 text-text-tertiary" />
                      <span className="truncate">{f.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-text-tertiary">{formatSize(f.size)}</span>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        className="text-xs text-text-tertiary transition-colors hover:text-text-primary"
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {checklistConflict ? <ChecklistPanel uploadAllowed={false} error={checklistConflict.message} onRetry={() => checklist.mutate()} /> : checklist.data ? <SavedChecklist key={checklist.data.id} bindingId={checklist.data.id} initial={checklist.data} /> : checklist.isLoading ? <ChecklistPanel /> : checklist.error ? <ChecklistPanel uploadAllowed={!error} error="The card could not be prepared." onRetry={() => checklist.mutate()} /> : null}

          <UploadZone className="mt-2" onFilesSelected={addFiles} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-status-error">
              {error}
            </p>
          )}

          <Button type="submit" disabled={!files.length || !workspace || !cardUrl.trim() || phase === "working"}>
            {phase === "working" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {step}
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Hand in
              </>
            )}
          </Button>
        </form>
      )}
    </div>
  );
}

export default function HandinPage() {
  // The parts upload is a beta: the existing complete-ad upload stays the default
  // and the split upload sits next to it as a second, labelled option.
  const [mode, setMode] = React.useState<'components' | 'complete'>('complete');
  const [locked, setLocked] = React.useState(false);
  const lock = React.useCallback(() => setLocked(true), []);
  if (!partsEnabled) return <CompleteHandinPage />;
  return <div className="owner-workspace handin-workspace min-h-full">
    <div className="mx-auto flex max-w-[1040px] gap-2 px-5 pt-6 sm:px-8" aria-label="Submission format">
      {(['complete', 'components'] as const).map(value => <button key={value} disabled={locked} aria-pressed={mode === value} onClick={() => setMode(value)} className={`press min-h-11 rounded-full px-4 text-sm font-medium ${mode === value ? 'bg-bg-hover text-text-primary' : 'text-text-secondary'}`}>{value === 'components' ? <>Split upload <span className="ml-1 rounded-full bg-accent/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Beta</span></> : 'Complete ads'}</button>)}
    </div>
    {mode === 'components' ? <PartsHandin onStarted={lock} /> : <CompleteHandinPage onStarted={lock} />}
  </div>;
}
