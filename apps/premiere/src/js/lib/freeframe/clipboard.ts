// Copy text from inside a CEP panel.
//
// `navigator.clipboard.writeText` is frequently rejected inside CEP (no secure
// context / no user-activation propagation through the host), and callers that
// did `navigator.clipboard?.writeText(url)` without awaiting it silently copied
// nothing. Try, in order: the async Clipboard API, the legacy execCommand path,
// and finally the OS clipboard tool through Node (the panel runs with
// --enable-nodejs --mixed-context).

function copyWithExecCommand(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const previous = document.activeElement as HTMLElement | null;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
    previous?.focus?.();
  }
}

function copyWithNode(text: string): boolean {
  try {
    const req = (window as unknown as { require?: (id: string) => unknown }).require;
    if (typeof window === "undefined" || typeof req !== "function") return false;
    const cp = req("child_process") as typeof import("child_process");
    const platform = (req("os") as typeof import("os")).platform();
    if (platform === "win32") {
      cp.execSync("clip", { input: text, windowsHide: true });
    } else if (platform === "darwin") {
      cp.execSync("pbcopy", { input: text });
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Copies `text` to the system clipboard. Resolves to whether any method succeeded. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the fallbacks
  }
  if (copyWithExecCommand(text)) return true;
  return copyWithNode(text);
}
