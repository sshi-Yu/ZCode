import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EnterpriseCodingPlanPricingResponse, ProviderFamilyDomain } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { logger } from "@/logger.js";
import {
  buildEnterpriseCodingPlanProductList,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";

interface EnterpriseCodingPlanProductsState {
  snapshot: EnterpriseCodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

export interface EnterpriseCodingPlanProductsSnapshot {
  productList: EnterpriseCodingPlanProductDisplay[];
  raw: EnterpriseCodingPlanPricingResponse;
  authenticated: boolean;
}

/** 账号项目读取保留原 family、Key 准备和错误语义；公开商品目录不再是模型准入前提。 */
export function useEnterpriseCodingPlanProducts({
  enabled,
  authenticated,
  family = "bigmodel",
}: {
  enabled: boolean;
  authenticated: boolean;
  family?: ProviderFamilyDomain;
}) {
  const services = useOptionalServices();
  const service = services?.accountModelProjectsService;
  const authScope = useZCodeStoreWithDefault(
    (state) => (state.user ? `${state.user.id}:${state.authSessionSeq}` : "signed-out"),
    "unscoped",
  );
  const scope = useMemo(
    () => ({ service, family, authenticated, authScope }),
    [service, family, authenticated, authScope],
  );
  const requestSequence = useRef(0);
  const owner = useRef({ scope, enabled, mounted: true });
  owner.current = { scope, enabled, mounted: true };
  const [owned, setOwned] = useState<{ scope: object; state: EnterpriseCodingPlanProductsState }>({
    scope,
    state: { snapshot: null, loading: enabled, error: null },
  });
  // 账号切换的同一渲染帧就隔离旧组织，不能等待 effect 清理。
  const state = useMemo<EnterpriseCodingPlanProductsState>(
    () => (owned.scope === scope ? owned.state : { snapshot: null, loading: enabled, error: null }),
    [enabled, owned, scope],
  );
  const refresh = useCallback(
    async (_options?: { force?: boolean }) => {
      const requestId = ++requestSequence.current;
      const isCurrent = () =>
        requestSequence.current === requestId &&
        owner.current.scope === scope &&
        owner.current.enabled &&
        owner.current.mounted;
      if (!enabled) {
        setOwned({ scope, state: { snapshot: null, loading: false, error: null } });
        return;
      }
      if (!service) {
        setOwned({
          scope,
          state: { snapshot: null, loading: false, error: "service_unavailable" },
        });
        return;
      }
      setOwned((previous) => ({
        scope,
        state: {
          snapshot: previous.scope === scope ? previous.state.snapshot : null,
          loading: true,
          error: null,
        },
      }));
      try {
        const raw = await service.getEnterprisePricing({ authenticated, family });
        if (!isCurrent()) return;
        setOwned({
          scope,
          state: {
            snapshot: {
              raw,
              authenticated,
              productList: buildEnterpriseCodingPlanProductList(
                raw.productList.filter((product) => product.subscribed === true),
              ).map((product) => ({ ...product, family })),
            },
            loading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : String(error);
        // 读取失败是未知；保留同账号上次项目，不能当成成功空列表清除已选 Team Plan。
        setOwned((previous) => ({
          scope,
          state: {
            snapshot: previous.scope === scope ? previous.state.snapshot : null,
            loading: false,
            error: message,
          },
        }));
        if (!isRemoteWorkspaceDisconnectedError(error)) {
          logger.warn("[useEnterpriseCodingPlanProducts] 读取账号团队项目失败", {
            authenticated,
            family,
            error: message,
          });
        }
      }
    },
    [authenticated, enabled, family, scope, service],
  );

  useEffect(() => {
    owner.current.mounted = true;
    void refresh();
    return () => {
      owner.current.mounted = false;
    };
  }, [refresh]);
  return useMemo(() => ({ ...state, refresh }), [refresh, state]);
}
