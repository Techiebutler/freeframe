"use client";

import * as React from "react";
import * as Select from "@radix-ui/react-select";
import { ChevronDown, Check } from "lucide-react";
import type { WatermarkTemplate } from "@/types";

const NONE_VALUE = "__default__";

interface TemplatePickerProps {
  templates: WatermarkTemplate[];
  value: string | null;
  onChange: (templateId: string | null) => void;
  disabled?: boolean;
  /** Label for the "no specific template" option */
  defaultLabel?: string;
}

/** Dropdown for choosing a watermark template (or falling back to defaults). */
export function TemplatePicker({
  templates,
  value,
  onChange,
  disabled,
  defaultLabel = "Project default",
}: TemplatePickerProps) {
  return (
    <Select.Root
      value={value ?? NONE_VALUE}
      onValueChange={(v) => onChange(v === NONE_VALUE ? null : v)}
      disabled={disabled}
    >
      <Select.Trigger className="inline-flex w-full items-center justify-between gap-2 rounded-md border border-border bg-bg-secondary px-3 h-8 text-sm text-text-primary hover:bg-bg-tertiary transition-colors focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed">
        <Select.Value />
        <ChevronDown className="h-4 w-4 text-text-tertiary shrink-0" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="z-[60] min-w-[200px] overflow-hidden rounded-md border border-border bg-bg-secondary shadow-xl">
          <Select.Viewport className="p-1">
            <Select.Item
              value={NONE_VALUE}
              className="relative flex items-center gap-2 rounded-sm px-7 py-1.5 text-sm text-text-secondary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
            >
              <Select.ItemIndicator className="absolute left-2">
                <Check className="h-3.5 w-3.5 text-accent" />
              </Select.ItemIndicator>
              <Select.ItemText>{defaultLabel}</Select.ItemText>
            </Select.Item>
            {templates.map((t) => (
              <Select.Item
                key={t.id}
                value={t.id}
                className="relative flex items-center gap-2 rounded-sm px-7 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
              >
                <Select.ItemIndicator className="absolute left-2">
                  <Check className="h-3.5 w-3.5 text-accent" />
                </Select.ItemIndicator>
                <Select.ItemText>
                  {t.name}
                  {t.scope === "instance" ? " · shared" : ""}
                </Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
