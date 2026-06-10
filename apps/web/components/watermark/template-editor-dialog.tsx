"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import * as Select from "@radix-ui/react-select";
import { Plus, Trash2, X, ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WatermarkPreview } from "./watermark-preview";
import type { WatermarkBlock, WatermarkBlockField, WatermarkTemplate } from "@/types";

const FIELD_OPTIONS: { value: WatermarkBlockField; label: string }[] = [
  { value: "email", label: "Viewer email" },
  { value: "name", label: "Viewer name" },
  { value: "ip", label: "IP address" },
  { value: "date", label: "Date viewed" },
  { value: "share_name", label: "Share name" },
  { value: "custom_text", label: "Custom text" },
];

function defaultBlock(): WatermarkBlock {
  return {
    field: "email",
    custom_text: null,
    x: 50,
    y: 50,
    size: 4,
    color: "#FFFFFF",
    opacity: 0.35,
    rotation: 0,
    shadow: true,
    scroll: false,
    tiled: false,
  };
}

function FieldSelect({
  value,
  onChange,
}: {
  value: WatermarkBlockField;
  onChange: (v: WatermarkBlockField) => void;
}) {
  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as WatermarkBlockField)}>
      <Select.Trigger className="inline-flex w-full items-center justify-between gap-2 rounded-md border border-border bg-bg-secondary px-3 h-8 text-sm text-text-primary hover:bg-bg-tertiary transition-colors focus:outline-none">
        <Select.Value />
        <ChevronDown className="h-4 w-4 text-text-tertiary shrink-0" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="z-[60] min-w-[160px] overflow-hidden rounded-md border border-border bg-bg-secondary shadow-xl">
          <Select.Viewport className="p-1">
            {FIELD_OPTIONS.map((opt) => (
              <Select.Item
                key={opt.value}
                value={opt.value}
                className="relative flex items-center gap-2 rounded-sm px-7 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
              >
                <Select.ItemIndicator className="absolute left-2">
                  <Check className="h-3.5 w-3.5 text-accent" />
                </Select.ItemIndicator>
                <Select.ItemText>{opt.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function MiniToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-text-secondary">
      {label}
      <Switch.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative inline-flex h-4 w-7 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none data-[state=checked]:bg-accent data-[state=unchecked]:bg-bg-tertiary"
      >
        <Switch.Thumb className="pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0" />
      </Switch.Root>
    </label>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-text-secondary">
        <span>{label}</span>
        <span className="tabular-nums text-text-tertiary">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-accent"
      />
    </div>
  );
}

interface TemplateEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Template being edited, or null to create a new one */
  template: WatermarkTemplate | null;
  /** Where new templates are created: a project id, or null for instance scope */
  projectId: string | null;
  onSaved: (template: WatermarkTemplate) => void;
}

export function TemplateEditorDialog({
  open,
  onOpenChange,
  template,
  projectId,
  onSaved,
}: TemplateEditorDialogProps) {
  const [name, setName] = React.useState("");
  const [blocks, setBlocks] = React.useState<WatermarkBlock[]>([defaultBlock()]);
  const [selected, setSelected] = React.useState<number>(0);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    if (template) {
      setName(template.name);
      setBlocks(template.blocks.length ? template.blocks : [defaultBlock()]);
    } else {
      setName("");
      setBlocks([defaultBlock()]);
    }
    setSelected(0);
    setError("");
  }, [open, template]);

  const updateBlock = (index: number, patch: Partial<WatermarkBlock>) => {
    setBlocks((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  };

  const addBlock = () => {
    setBlocks((prev) => {
      const next = [...prev, { ...defaultBlock(), y: Math.min(90, 50 + prev.length * 10) }];
      setSelected(next.length - 1);
      return next;
    });
  };

  const removeBlock = (index: number) => {
    setBlocks((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((_, i) => i !== index);
      setSelected((s) => Math.min(s, next.length - 1));
      return next;
    });
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Give the template a name.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      let saved: WatermarkTemplate;
      if (template) {
        saved = await api.patch<WatermarkTemplate>(
          `/watermark-templates/${template.id}`,
          { name: name.trim(), blocks },
        );
      } else if (projectId) {
        saved = await api.post<WatermarkTemplate>(
          `/projects/${projectId}/watermark-templates`,
          { name: name.trim(), blocks },
        );
      } else {
        saved = await api.post<WatermarkTemplate>("/watermark-templates", {
          name: name.trim(),
          blocks,
        });
      }
      onSaved(saved);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  const block = blocks[selected];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-5 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 max-h-[90vh] overflow-y-auto">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>
          <Dialog.Title className="text-base font-semibold text-text-primary">
            {template ? "Edit watermark template" : "New watermark template"}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-text-tertiary">
            Drag text on the preview to position it. Viewer details are filled in
            automatically when someone watches.
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            <Input
              label="Template name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Tiled email for client shares"
            />

            <div className="grid grid-cols-1 md:grid-cols-[1fr_240px] gap-4">
              {/* Preview */}
              <WatermarkPreview
                blocks={blocks}
                selectedIndex={selected}
                onSelectBlock={setSelected}
                onMoveBlock={(i, x, y) => updateBlock(i, { x, y })}
              />

              {/* Block controls */}
              <div className="space-y-3">
                {/* Block tabs */}
                <div className="flex items-center gap-1 flex-wrap">
                  {blocks.map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setSelected(i)}
                      className={cn(
                        "h-6 px-2 rounded text-xs font-medium transition-colors",
                        i === selected
                          ? "bg-accent text-white"
                          : "bg-bg-tertiary text-text-secondary hover:text-text-primary",
                      )}
                    >
                      {i + 1}
                    </button>
                  ))}
                  {blocks.length < 10 && (
                    <button
                      type="button"
                      onClick={addBlock}
                      className="h-6 w-6 rounded bg-bg-tertiary text-text-secondary hover:text-text-primary flex items-center justify-center transition-colors"
                      title="Add text block"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  )}
                  {blocks.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeBlock(selected)}
                      className="h-6 w-6 rounded bg-bg-tertiary text-status-error hover:bg-status-error/10 flex items-center justify-center transition-colors"
                      title="Remove selected block"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {block && (
                  <>
                    <FieldSelect
                      value={block.field}
                      onChange={(field) => updateBlock(selected, { field })}
                    />

                    {block.field === "custom_text" && (
                      <Input
                        value={block.custom_text ?? ""}
                        onChange={(e) =>
                          updateBlock(selected, { custom_text: e.target.value })
                        }
                        placeholder="CONFIDENTIAL"
                      />
                    )}

                    <SliderRow
                      label="Size"
                      value={block.size}
                      min={1}
                      max={15}
                      step={0.5}
                      display={`${block.size}%`}
                      onChange={(size) => updateBlock(selected, { size })}
                    />
                    <SliderRow
                      label="Opacity"
                      value={block.opacity}
                      min={0.05}
                      max={1}
                      step={0.05}
                      display={`${Math.round(block.opacity * 100)}%`}
                      onChange={(opacity) => updateBlock(selected, { opacity })}
                    />
                    <SliderRow
                      label="Rotation"
                      value={block.rotation}
                      min={-90}
                      max={90}
                      step={5}
                      display={`${block.rotation}°`}
                      onChange={(rotation) => updateBlock(selected, { rotation })}
                    />

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-secondary">Color</span>
                      <input
                        type="color"
                        value={block.color}
                        onChange={(e) => updateBlock(selected, { color: e.target.value })}
                        className="h-7 w-10 rounded border border-border bg-bg-secondary cursor-pointer"
                      />
                    </div>

                    <div className="space-y-2 rounded-lg border border-border bg-bg-tertiary/50 p-2.5">
                      <MiniToggle
                        label="Shadow"
                        checked={block.shadow}
                        onChange={(shadow) => updateBlock(selected, { shadow })}
                      />
                      <MiniToggle
                        label="Repeat across frame"
                        checked={block.tiled}
                        onChange={(tiled) => updateBlock(selected, { tiled })}
                      />
                      <MiniToggle
                        label="Drift slowly (video)"
                        checked={block.scroll}
                        onChange={(scroll) => updateBlock(selected, { scroll })}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {error && <p className="text-xs text-status-error">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={handleSave} loading={saving}>
                {template ? "Save changes" : "Create template"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
