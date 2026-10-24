import type { SelectOption, SelectRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { onMount } from "solid-js";
import type { ModelInfo } from "../agent/models.ts";

const money = (usd: number) => `$${Number(usd.toFixed(4))}`;

/** `$4 in / $20 out` per million tokens. */
export const priceLabel = (m: ModelInfo) =>
  `${money(m.inputPerMTok)} in / ${money(m.outputPerMTok)} out${m.priced ? "" : " (Pi est.)"}`;

export interface ModelPickerProps {
  models: readonly ModelInfo[];
  /** `provider/id` of the session's model; the list starts on it. */
  current: string;
  onPick: (model: string) => void;
  onClose: () => void;
}

/**
 * The `/model` picker: the models that have credentials, with prices. Up/Down moves,
 * Enter switches, Esc closes. `/model provider/id` skips it.
 */
export function ModelPicker(props: ModelPickerProps) {
  const options = (): SelectOption[] =>
    props.models.map((m) => ({
      name: `${m.id === props.current ? "● " : "  "}${m.id}`,
      description: `${m.name} · ${priceLabel(m)} per MTok`,
      value: m.id,
    }));
  const start = Math.max(
    0,
    props.models.findIndex((m) => m.id === props.current),
  );

  let list: SelectRenderable | undefined;
  // `selectedIndex` as a prop is applied before the options exist; set it once mounted.
  onMount(() => list?.setSelectedIndex(start));

  useKeyboard((key) => {
    if (key.name === "escape") props.onClose();
  });

  return (
    <box
      border
      title="switch model (Enter picks, Esc closes)"
      flexDirection="column"
      height={Math.min(props.models.length * 2 + 2, 14)}
    >
      <select
        ref={(r: SelectRenderable) => {
          list = r;
        }}
        focused
        flexGrow={1}
        options={options()}
        showDescription
        onSelect={(_i: number, option: SelectOption | null) => {
          if (option?.value) props.onPick(String(option.value));
        }}
      />
    </box>
  );
}
