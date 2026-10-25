import type { ModelInfo } from "../agent/models.ts";
import { Picker } from "./picker.tsx";

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
  /** The filter, kept by the parent (see `Picker`). */
  query?: string;
  onQuery?: (query: string) => void;
}

/**
 * The `/model` picker: the models that have credentials, with prices, grouped by provider.
 * Typing filters, Up/Down moves, Enter switches, Esc closes. `/model provider/id` skips it.
 */
export function ModelPicker(props: ModelPickerProps) {
  // Grouped: providers in the order they first appear, models in the daemon's order.
  const providers = [...new Set(props.models.map((m) => m.provider))];
  const models = providers.flatMap((p) => props.models.filter((m) => m.provider === p));
  return (
    <Picker
      spec={{
        title: "Switch model",
        rows: models.map((m) => ({
          cells: [m.id, priceLabel(m), m.name],
          current: m.id === props.current,
          group: m.provider,
        })),
        start: Math.max(
          0,
          models.findIndex((m) => m.id === props.current),
        ),
        onPick: (i) => {
          const m = models[i];
          if (m) props.onPick(m.id);
        },
      }}
      onClose={props.onClose}
      {...(props.onQuery ? { query: props.query ?? "", onQuery: props.onQuery } : {})}
    />
  );
}
