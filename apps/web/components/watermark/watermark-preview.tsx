"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { WatermarkBlock } from "@/types";

// Mirrors the server-side tiled layout
const TILE_POSITIONS: Array<[number, number]> = [
  [17, 17], [50, 12], [83, 17],
  [12, 50], [50, 50], [88, 50],
  [17, 83], [50, 88], [83, 83],
];

const SAMPLE_VALUES: Record<string, string> = {
  name: "Alex Producer",
  email: "alex@example.com",
  ip: "203.0.113.7",
  share_name: "Client Review",
};

export function sampleBlockText(block: WatermarkBlock): string {
  switch (block.field) {
    case "custom_text":
      return block.custom_text || "Your text";
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "name":
    case "email":
    case "ip":
    case "share_name":
      return SAMPLE_VALUES[block.field];
    default: {
      const _exhaustive: never = block.field;
      return _exhaustive;
    }
  }
}

interface WatermarkPreviewProps {
  blocks: WatermarkBlock[];
  selectedIndex?: number | null;
  onSelectBlock?: (index: number) => void;
  onMoveBlock?: (index: number, x: number, y: number) => void;
  className?: string;
}

/**
 * A 16:9 preview frame showing watermark blocks with sample viewer values.
 * Blocks can be selected and dragged to reposition when handlers are given.
 */
export function WatermarkPreview({
  blocks,
  selectedIndex,
  onSelectBlock,
  onMoveBlock,
  className,
}: WatermarkPreviewProps) {
  const frameRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{ index: number } | null>(null);

  const handlePointerMove = React.useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      const frame = frameRef.current;
      if (!drag || !frame || !onMoveBlock) return;
      const rect = frame.getBoundingClientRect();
      const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
      const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
      onMoveBlock(drag.index, Math.round(x * 10) / 10, Math.round(y * 10) / 10);
    },
    [onMoveBlock],
  );

  const handlePointerUp = React.useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
  }, [handlePointerMove]);

  const startDrag = (index: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectBlock?.(index);
    if (!onMoveBlock) return;
    dragRef.current = { index };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  React.useEffect(
    () => () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    },
    [handlePointerMove, handlePointerUp],
  );

  return (
    <div
      ref={frameRef}
      className={cn(
        "relative w-full aspect-video rounded-lg overflow-hidden select-none",
        "bg-gradient-to-br from-zinc-800 via-zinc-900 to-black border border-border",
        className,
      )}
      style={{ containerType: "size" }}
    >
      {/* Faux video content so opacity is readable */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="h-1/3 w-1/2 rounded-xl bg-white/[0.04] border border-white/[0.06]" />
      </div>

      {blocks.map((block, i) => {
        const positions: Array<[number, number]> = block.tiled
          ? TILE_POSITIONS
          : [[block.x, block.y]];
        const text = sampleBlockText(block);
        return positions.map(([x, y], j) => (
          <span
            key={`${i}-${j}`}
            onPointerDown={block.tiled ? () => onSelectBlock?.(i) : startDrag(i)}
            className={cn(
              "absolute whitespace-nowrap font-semibold tracking-wide",
              (onSelectBlock || onMoveBlock) && "cursor-move",
              selectedIndex === i &&
                j === 0 &&
                "outline outline-1 outline-accent outline-offset-2 rounded-sm",
            )}
            style={{
              left: `${x}%`,
              top: `${y}%`,
              transform: `translate(-50%, -50%) rotate(${block.rotation}deg)`,
              fontSize: `${block.size}cqh`,
              color: block.color,
              opacity: block.opacity,
              textShadow: block.shadow ? "2px 2px 4px rgba(0,0,0,0.8)" : undefined,
            }}
          >
            {text}
          </span>
        ));
      })}
    </div>
  );
}
