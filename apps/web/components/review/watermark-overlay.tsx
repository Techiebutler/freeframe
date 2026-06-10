"use client";

import React from "react";
import type { WatermarkRender, WatermarkRenderBlock } from "@/types";

// Grid positions (percent) used to emulate a tiled watermark — mirrors the
// server-side burn-in layout so playback and downloads look the same.
const TILE_POSITIONS: Array<[number, number]> = [
  [17, 17], [50, 12], [83, 17],
  [12, 50], [50, 50], [88, 50],
  [17, 83], [50, 88], [83, 83],
];

interface WatermarkOverlayProps {
  watermark: WatermarkRender | null | undefined;
}

function BlockText({
  block,
  x,
  y,
}: {
  block: WatermarkRenderBlock;
  x: number;
  y: number;
}) {
  const style: React.CSSProperties = {
    position: "absolute",
    left: `${x}%`,
    top: `${y}%`,
    transform: `translate(-50%, -50%) rotate(${block.rotation}deg)`,
    // cqh: percent of the overlay container height, matching the server-side
    // "size = percent of frame height" semantics
    fontSize: `${block.size}cqh`,
    color: block.color,
    opacity: block.opacity,
    whiteSpace: "nowrap",
    fontWeight: 600,
    letterSpacing: "0.02em",
    textShadow: block.shadow ? "2px 2px 4px rgba(0,0,0,0.8)" : undefined,
    userSelect: "none",
  };
  return <span style={style}>{block.text}</span>;
}

/**
 * Renders a resolved watermark (from the stream API) over media. The parent
 * must be positioned; the overlay fills it and ignores pointer events.
 */
export function WatermarkOverlay({ watermark }: WatermarkOverlayProps) {
  if (!watermark?.enabled || watermark.blocks.length === 0) return null;

  return (
    <div
      aria-hidden
      className="absolute inset-0 pointer-events-none select-none overflow-hidden z-20"
      style={{ containerType: "size" }}
      data-testid="watermark-overlay"
    >
      {watermark.blocks.map((block, i) => {
        const positions: Array<[number, number]> = block.tiled
          ? TILE_POSITIONS
          : [[block.x, block.y]];
        const inner = positions.map(([x, y], j) => (
          <BlockText key={j} block={block} x={x} y={y} />
        ));
        if (block.scroll) {
          return (
            <div key={i} className="absolute inset-0 wm-scroll">
              {inner}
            </div>
          );
        }
        return (
          <div key={i} className="absolute inset-0">
            {inner}
          </div>
        );
      })}
    </div>
  );
}
