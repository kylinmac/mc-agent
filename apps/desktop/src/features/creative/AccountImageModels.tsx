import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { vendorServesAccountImages, type ProviderPublic } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { IconX } from "../../components/icons";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
// Settings may open before the studio has loaded its styles.
import "./creative.css";

/*
  mc-agent (docs/mc-agent/creative-studio.md): image models added by hand to a
  signed-in subscription account (ChatGPT, Grok). They join the account's own
  list, so a new model can be used before the app knows it.
*/
export function AccountImageModels({ providers }: { providers: readonly ProviderPublic[] }) {
  const { t } = useTranslation();
  const refreshProviders = useAppStore((state) => state.refreshProviders);
  const showToast = useAppStore((state) => state.showToast);
  const accounts = providers.filter(
    (provider) => provider.authKind === "oauth" && provider.hasOauth && vendorServesAccountImages(provider.vendorKey),
  );
  const [added, setAdded] = useState<Record<string, string[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.creative
      .call<{ models: Record<string, string[]> }>("creative.accountImageModels")
      .then((answer) => setAdded(answer.models ?? {}))
      .catch(() => undefined);
  }, []);

  if (!accounts.length) return null;

  const save = async (providerId: string, modelIds: string[]) => {
    try {
      const { modelIds: saved } = await api.creative.call<{ modelIds: string[] }>("creative.setAccountImageModels", {
        providerId,
        modelIds,
      });
      setAdded((current) => ({ ...current, [providerId]: saved }));
      setDrafts((current) => ({ ...current, [providerId]: "" }));
      await refreshProviders();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  return (
    <div className="mc-account-image-models">
      <div className="settings-row-detail">{t("mcProject.accountImageModelsHint")}</div>
      <div className="mc-account-image-table" role="table" aria-label={t("mcProject.accountImageModelsTitle")}>
        <div className="mc-account-image-models-row is-head" role="row">
          <span className="mc-account-image-models-name" role="columnheader">{t("mcProject.accountImageModelsAccount")}</span>
          <span className="mc-account-image-models-ids" role="columnheader">{t("mcProject.accountImageModelsModels")}</span>
        </div>
      {accounts.map((account) => {
        const mine = added[account.id] ?? [];
        const offered = (account.accountImageModels ?? []).filter(
          (id) => !mine.some((entry) => entry.toLowerCase() === id.toLowerCase()),
        );
        return (
          <div key={account.id} className="mc-account-image-models-row" role="row">
            <span className="mc-account-image-models-name" role="cell" title={account.name}>{account.name}</span>
            <div className="mc-account-image-models-ids" role="cell">
              {offered.map((id) => (
                <span key={id} className="mc-account-image-chip is-builtin" title={t("mcProject.accountImageModelsFromAccount")}>
                  {id}
                </span>
              ))}
              {mine.map((id) => (
                <span key={id} className="mc-account-image-chip">
                  {id}
                  <button
                    type="button"
                    aria-label={t("mcProject.accountImageModelsRemove", { id })}
                    onClick={() => void save(account.id, mine.filter((entry) => entry !== id))}
                  >
                    <IconX size={11} />
                  </button>
                </span>
              ))}
              <form
                className="mc-account-image-models-add"
                onSubmit={(event) => {
                  event.preventDefault();
                  const id = (drafts[account.id] ?? "").trim();
                  if (id) void save(account.id, [...mine, id]);
                }}
              >
                <input
                  className="mc-creative-input"
                  value={drafts[account.id] ?? ""}
                  placeholder={t("mcProject.accountImageModelsPlaceholder")}
                  onChange={(event) => setDrafts((current) => ({ ...current, [account.id]: event.target.value }))}
                />
                <Button size="sm" variant="secondary" type="submit" disabled={!(drafts[account.id] ?? "").trim()}>
                  {t("mcProject.accountImageModelsAdd")}
                </Button>
              </form>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
