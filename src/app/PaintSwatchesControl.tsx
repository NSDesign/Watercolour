"use client";

import * as React from "react";
import type { ToolcraftCustomControlRenderer } from "@/toolcraft/runtime/react";

import { defaultPigmentHex } from "./pigments";

type CurrentPigmentValue = {
  hex: string;
  pickedAt: number;
};

function normalizeValue(rawValue: unknown): CurrentPigmentValue {
  if (
    rawValue &&
    typeof rawValue === "object" &&
    typeof (rawValue as CurrentPigmentValue).hex === "string"
  ) {
    return rawValue as CurrentPigmentValue;
  }

  return { hex: defaultPigmentHex, pickedAt: 0 };
}

export const PaintSwatchesControl: ToolcraftCustomControlRenderer = ({
  control,
  controlId,
  setValue,
  value,
}) => {
  const current = normalizeValue(value);
  const options = control.options ?? [];

  return (
    <div
      className="flex flex-wrap gap-2"
      data-toolcraft-control-id={controlId}
      data-toolcraft-paint-swatches="true"
      role="radiogroup"
    >
      {options.map((option) => {
        const isSelected = option.value.toLowerCase() === current.hex.toLowerCase();

        return (
          <button
            aria-checked={isSelected}
            aria-label={option.label}
            className="size-8 shrink-0 rounded-full border-2 transition-transform"
            data-toolcraft-pigment-swatch={option.label.toLowerCase()}
            key={option.value}
            onClick={() => {
              setValue({ hex: option.value, pickedAt: Date.now() });
            }}
            role="radio"
            style={{
              backgroundColor: option.value,
              borderColor: isSelected ? "var(--foreground)" : "transparent",
              transform: isSelected ? "scale(1.08)" : "scale(1)",
            }}
            title={option.label}
            type="button"
          />
        );
      })}
    </div>
  );
};
