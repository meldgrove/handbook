import { lazy, Suspense } from "react";
import { LoadingState } from "@/components/states";
import type { EditorWorkspaceProps } from "./editor-workspace";

const Workspace = lazy(() =>
  import("./editor-workspace").then((module) => ({ default: module.EditorWorkspace })),
);

/** The editor work area, loaded when first needed (the text editor is large). */
export function LazyEditorWorkspace(props: EditorWorkspaceProps) {
  return (
    <Suspense fallback={<LoadingState />}>
      <Workspace {...props} />
    </Suspense>
  );
}
