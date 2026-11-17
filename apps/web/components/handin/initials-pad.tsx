"use client";

/**
 * Handwritten initials (V3 C follow-up, Alan 2026-11-17): a finger on a phone, the mouse on a desktop. Strokes are drawn
 * on a canvas at the screen's pixel density; `onChange` gets a PNG data URL once something is drawn, null after Clear.
 */
import * as React from "react";

export function InitialsPad({ onChange, label = "Initials" }: { onChange: (png: string | null) => void; label?: string }) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const last = React.useRef<{ x: number; y: number } | null>(null);
  const [inked, setInked] = React.useState(false);
  const drawn = React.useRef(false); // the release reads this, not the state: a quick stroke ends before a re-render

  React.useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const fit = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      const g = c.getContext("2d");
      if (!g) return;
      g.scale(dpr, dpr);
      g.lineCap = "round";
      g.lineJoin = "round";
      g.lineWidth = 3;
      g.strokeStyle = getComputedStyle(c).color;
    };
    fit();
  }, []);

  const at = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
    last.current = at(e);
  };
  const move = (e: React.PointerEvent) => {
    const g = canvas.current?.getContext("2d");
    if (!last.current || !g) return;
    const p = at(e);
    g.beginPath();
    g.moveTo(last.current.x, last.current.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
    if (!drawn.current) { drawn.current = true; setInked(true); }
  };
  const up = () => {
    last.current = null;
    if (drawn.current && canvas.current) onChange(canvas.current.toDataURL("image/png"));
  };
  const clear = () => {
    const c = canvas.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    drawn.current = false;
    setInked(false);
    onChange(null);
  };

  return (
    <div className="flex w-full max-w-md flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary" id="initials-label">{label}</span>
        {inked && <button type="button" onClick={clear} className="min-h-11 px-2 text-sm text-text-tertiary hover:text-text-primary">Clear</button>}
      </div>
      <canvas ref={canvas} aria-labelledby="initials-label" role="img" data-inked={inked ? "" : undefined}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        className="h-36 w-full touch-none rounded-lg border border-border bg-bg-secondary text-text-primary data-[inked]:border-border-focus" />
    </div>
  );
}
