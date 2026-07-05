import * as React from "react";
import { ToolcraftApp } from "@/toolcraft/runtime/react";
import { createToolcraftPngExportCanvas, getToolcraftImageExportSize } from "@/toolcraft/runtime";

import { appSchema } from "../app/app-schema";
import { MixingAreaControl } from "../app/MixingAreaControl";
import { PaintSwatchesControl } from "../app/PaintSwatchesControl";
import { WatercolorCanvas, type WatercolorCanvasApi } from "../app/WatercolorCanvas";

const controlRenderers = {
  mixingArea: MixingAreaControl,
  paintSwatches: PaintSwatchesControl,
};

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AppHome(): React.JSX.Element {
  const canvasApiRef = React.useRef<WatercolorCanvasApi | null>(null);

  return (
    <ToolcraftApp
      className="h-dvh min-h-dvh"
      canvasContent={<WatercolorCanvas apiRef={canvasApiRef} />}
      controlRenderers={controlRenderers}
      onPanelAction={async ({ action, dispatch, state }) => {
        switch (action.value) {
          case "canvas-clear-painting": {
            canvasApiRef.current?.clear();
            return;
          }

          case "water-refresh": {
            canvasApiRef.current?.refreshWater();
            return;
          }

          case "mixing-reset": {
            dispatch({
              target: "paint.mixingArea",
              type: "controls.setValue",
              value: { pixels: null },
            });
            return;
          }

          case "export-png": {
            const format = (state.values["export.image.format"] as "png" | "jpg" | undefined) ?? "png";
            const resolution =
              (state.values["export.image.resolution"] as "2k" | "4k" | "8k" | undefined) ?? "4k";
            const source = canvasApiRef.current?.getCompositeCanvas();

            if (!source) {
              throw new Error("Toolcraft watercolour export produced no painted content.");
            }

            const exportCanvas = createToolcraftPngExportCanvas({
              includeBackground: true,
              render: ({ context, cssHeight, cssWidth }) => {
                context.drawImage(source, 0, 0, cssWidth, cssHeight);
              },
              resolution,
              state,
            });

            const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
            const blob = await new Promise<Blob | null>((resolve) => {
              exportCanvas.toBlob(resolve, mimeType);
            });

            if (!blob) {
              throw new Error("Toolcraft watercolour export failed to encode image bytes.");
            }

            const size = getToolcraftImageExportSize({ resolution, state });
            downloadBlob(
              blob,
              `watercolour-painting-${size.width}x${size.height}.${format === "jpg" ? "jpg" : "png"}`,
            );
            return;
          }

          default:
            return;
        }
      }}
      renderDefaultCanvasMedia={false}
      schema={appSchema}
    />
  );
}
