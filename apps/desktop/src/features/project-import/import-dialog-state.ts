import { create } from "zustand";

export const useProjectImportDialog = create<{ open: boolean }>(() => ({ open: false }));

export function openProjectImportDialog(): void {
  useProjectImportDialog.setState({ open: true });
}

export function closeProjectImportDialog(): void {
  useProjectImportDialog.setState({ open: false });
}
