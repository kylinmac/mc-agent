import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

/**
 * mc-agent (MC-ADR-0024): say when a review left memory suggestions waiting,
 * and where to answer them. Renders nothing.
 */
export function MemorySuggestionToast() {
  const { t } = useTranslation();
  useEffect(
    () =>
      api.mcMemory.onSuggestions(({ added }) => {
        if (added > 0) {
          useAppStore.getState().showToast(t("mcProject.memorySuggestedToast", { count: added }), {
            variant: "info",
            duration: 8000,
          });
        }
      }),
    [t],
  );
  return null;
}
