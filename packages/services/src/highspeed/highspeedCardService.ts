import {
  resolveHighspeedProviderId,
  HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
  type HighspeedCardUsage,
  type HighspeedCardSnapshot,
  type HighspeedPrepareTurnParams,
  type HighspeedPrepareTurnResult,
  type HighspeedServiceSnapshot,
  type HighspeedTurnExecution,
  type ModelSelection,
} from "@zcode/shared";
import type { IHighspeedCardService } from "#src/highspeed/highspeedCard.js";

export { createHighspeedHttpTransport } from "./highspeedHttpTransport.js";

export interface HighspeedServiceTransport {
  healthy(cardId: string, headers?: Record<string, string>): Promise<HighspeedCardUsage>;
}

/**
 * 加速推理的动态鉴权材料。加速走 /api/v1/highspeed/ 网关，与 draw 复用同一套 Coding Plan
 * 双 JWT 契约：zcode JWT 标识会话身份，Coding Plan 业务 JWT + Team 身份头校验套餐权益。
 * 这些字段必须来自同一次 selected connection 解析，禁止跨 Family 拼接
 * （ZAI JWT 配 BigModel key 只会在服务端取号时被拒）。
 */
export interface HighspeedInferenceAuth {
  accountScope?: string;
  ownerKey?: string;
  zcodeJwt: string;
  family: "zai" | "bigmodel";
  codingPlanAuthorization: string;
  targetType: "PERSONAL" | "TEAM";
  organizationId?: string;
  projectId?: string;
}

export interface HighspeedCardServiceOptions {
  transport: HighspeedServiceTransport;
  resolveHealthyIdentity?: () => Promise<{
    ownerKey: string;
    sessionScope: string;
    zcodeJwt: string;
  } | null>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  /**
   * 加速推理动态鉴权材料。加速卡按账号 Family 拆分，不跨 Family 静默迁移；必须与 draw
   * 复用同一次 selected connection 解析。缺省夹具仅服务本地测试。
   */
  resolveInferenceAuth?: () => Promise<HighspeedInferenceAuth>;
  /** Mock 抽中只验证业务状态，消息继续走 session 当前的普通推理路由。 */
  inferenceMode?: "highspeed" | "session-default";
}

const DEFAULT_WAIT_BUDGET_MS = 1000;

type SendBudgetOutcome<T> = { kind: "settled"; value: T } | { kind: "timeout" };
/** 让一段 await 与本次 prepareTurn 的发送预算竞速；预算耗尽只结束等待，不取消该请求。 */
type SendBudget = <T>(task: Promise<T>) => Promise<SendBudgetOutcome<T>>;

/**
 * Coding Plan 双 JWT + Team 身份头。draw 与加速推理走同一个 /api/v1/highspeed/ 网关、同一套
 * 鉴权中间件：两者必须携带完全一致的 Coding Plan 凭据，加速推理只是额外附带卡 ID。
 */
export function buildHighspeedCodingPlanAuthHeaders(params: {
  zcodeJwt: string;
  codingPlanAuthorization: string;
  targetType: "PERSONAL" | "TEAM";
  organizationId?: string;
  projectId?: string;
}): Record<string, string> {
  const zcodeJwt = params.zcodeJwt.trim();
  const codingPlanAuthorization = params.codingPlanAuthorization.trim();
  if (!zcodeJwt) throw new Error("highspeed request requires zcode jwt");
  if (!codingPlanAuthorization) throw new Error("highspeed request requires Coding Plan jwt");
  if (params.targetType === "TEAM" && (!params.organizationId || !params.projectId)) {
    throw new Error("highspeed team request requires organization and project");
  }
  return {
    Authorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
    // 接口契约要求 Bearer 前缀；凭据库可能存裸 token，这里统一归一化。
    "X-Bigmodel-Authorization": /^Bearer\s/i.test(codingPlanAuthorization)
      ? codingPlanAuthorization
      : `Bearer ${codingPlanAuthorization}`,
    "Bigmodel-Target-Type": params.targetType,
    ...(params.targetType === "TEAM"
      ? {
          "Bigmodel-Organization": params.organizationId!,
          "Bigmodel-Project": params.projectId!,
        }
      : {}),
  };
}

/**
 * 构造一次加速执行的选择与动态鉴权材料。Endpoint、API 形态和模型能力等静态事实由
 * ZCode Built-in Provider Config 提供，禁止再随单次发送下发 provider 定义。
 */
export function buildHighspeedTurnExecution(params: {
  card: HighspeedCardSnapshot;
  auth: HighspeedInferenceAuth;
  /**
   * 抽卡时的提交选择（会话原模型 + 思考档位）。加速只换端点不换模型，execution 选择沿用它的档位，
   * 否则 CLI Registry 会因缺档位拒绝本轮；它同时是降级的退回目标，必须随 selectionFallback 下发。
   */
  sessionSelection: ModelSelection;
}): HighspeedTurnExecution {
  const providerId = resolveHighspeedProviderId(params.auth.family);
  const reasoningLevel = params.sessionSelection.options?.reasoningLevel;
  return {
    modelSelection: {
      providerId,
      // 卡回显的是请求时提交的 model：加速来自换端点，不换模型。
      modelId: params.card.model,
      // execution 作用域的选择必须完整：带上会话档位，否则 CLI Registry 会因缺档位拒绝本轮。
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    },
    requestAuth: {
      // Anthropic 兼容客户端会发送 x-api-key；服务端仍以 Authorization、Coding Plan 双 JWT 与卡 ID 裁决。
      apiKey: params.auth.zcodeJwt,
      headers: {
        // Bug 原因：加速推理曾只发 zcode JWT + 卡 ID，而它与 draw 走同一 highspeed 网关、同一
        // 鉴权中间件，缺少 Coding Plan 双 JWT + Team 身份头时网关无法校验套餐权益，返回
        // 401 auth_failed。这里复用与 draw 完全一致的 Coding Plan 头，再附加本次执行的卡 ID。
        ...buildHighspeedCodingPlanAuthHeaders({
          zcodeJwt: params.auth.zcodeJwt,
          codingPlanAuthorization: params.auth.codingPlanAuthorization,
          targetType: params.auth.targetType,
          ...(params.auth.organizationId ? { organizationId: params.auth.organizationId } : {}),
          ...(params.auth.projectId ? { projectId: params.auth.projectId } : {}),
        }),
        "X-Highspeed-Card-ID": params.card.cardId,
      },
    },
    // 加速请求任何失败都退回会话模型跑完本轮（spec §2.2）：规则按序匹配，卡过期（3402）单独给出
    // 原因以便 Renderer 区分提示；兜底规则不带错误码，覆盖鉴权、限流、5xx、网络、超时、流中断。
    // CLI 只按声明匹配，不自行解释错误码；带该声明的执行句柄在适配层 0 次重试，首次失败即退回。
    selectionFallback: {
      providerId,
      rules: [
        {
          reason: "highspeed_card_expired",
          providerErrorCode: HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
        },
        { reason: "highspeed_request_failed" },
      ],
      // Bug 根因：退回目标曾只依赖 CLI 内存里的会话常驻选择。桌面重启后冷恢复若落在 Registry 刚就绪、
      // 账号权益未解析的窗口内，持久化选择校验失败不绑定；之后只发加速轮也不会再绑定，卡过期（3402）
      // 时降级静默跳过，整轮按 "highspeed card is invalid" 失败弹错。发起方在这里明确知道原模型，
      // 必须把它作为退回目标随声明下发（spec §2.2），不再押注 runtime 状态。
      target: structuredClone(params.sessionSelection),
    },
  };
}

export class HighspeedCardService implements IHighspeedCardService {
  private readonly transport: HighspeedServiceTransport;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  readonly #resolveInferenceAuth: () => Promise<HighspeedInferenceAuth>;
  private readonly inferenceMode: "highspeed" | "session-default";
  readonly #resolveHealthyIdentity: NonNullable<
    HighspeedCardServiceOptions["resolveHealthyIdentity"]
  >;
  private card: HighspeedCardSnapshot | null = null;
  private nextDrawAt: number | null = null;
  private credentialScope: string | null = null;

  constructor(options: HighspeedCardServiceOptions) {
    this.transport = options.transport;
    this.#resolveHealthyIdentity = options.resolveHealthyIdentity ?? (async () => null);
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#resolveInferenceAuth =
      options.resolveInferenceAuth ??
      (async () => ({
        zcodeJwt: "mock-zcode-jwt",
        family: "zai",
        codingPlanAuthorization: "mock-coding-plan-jwt",
        targetType: "PERSONAL",
      }));
    this.inferenceMode = options.inferenceMode ?? "highspeed";
  }

  async prepareTurn(params: HighspeedPrepareTurnParams): Promise<HighspeedPrepareTurnResult> {
    // Bug 原因：定时任务是后台输入轮，不应参与面向用户主动发送的抽卡；门禁必须只看
    // 本轮 automationId，不能读取 Task 上粘性的 cronAutomationId，否则同会话手动输入也会失去加速。
    if (params.automationId?.trim()) {
      return { kind: "fallback", reason: "automation", nextDrawAt: this.nextDrawAt };
    }

    const now = this.now();
    this.expireCard(now);
    // 个人工作台商业服务拆除（后端契约附录）：新抽卡（draw）属于促销获取链路，已从服务层退役。
    // 只有「已激活的卡」继续可用：无当前有效卡时不再发起 draw，直接按 unavailable 降级，
    // 会话轮次退回普通模型。已有卡的加速执行、healthy、归属隔离与到期规则保持原实现。
    if (!this.card) {
      return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
    }
    // Bug 根因：1s 预算曾只包住 draw 等待，门禁判定（模型目录要等 Provider Runtime 初始化）与
    // 加速鉴权解析都在预算外单独 await，Registry 未就绪或凭据解析卡住时发送被无限期挂起。
    // 预算从进入 prepareTurn 起算，所有 await 共享同一截止时间（spec §3 规则 12）。
    const withinBudget = this.createSendBudget(now, params.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS);

    // 卡和冷却都属于抽卡身份。同账号重登也会换 scope，不能继承上一会话的状态。
    if (this.credentialScope !== null && this.inferenceMode === "highspeed") {
      const scope = this.credentialScope;
      const auth = await withinBudget(this.#resolveInferenceAuth());
      if (auth.kind === "timeout") {
        return { kind: "fallback", reason: "draw-timeout", nextDrawAt: this.nextDrawAt };
      }
      if (scope !== this.authScope(auth.value)) {
        if (this.credentialScope === scope) this.clearCredentialState();
        return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
      }
    }
    return this.prepareWithCard(this.card, params, withinBudget);
  }

  async prepareExistingTurn(params: HighspeedPrepareTurnParams): Promise<HighspeedPrepareTurnResult> {
    return this.prepareTurn(params);
  }

  async getSnapshot(): Promise<HighspeedServiceSnapshot> {
    this.expireCard(this.now());
    return {
      card: this.card,
      nextDrawAt: this.nextDrawAt,
      // 个人工作台商业服务拆除：新 draw 已退役，不存在 in-flight 抽卡。
      drawing: false,
    };
  }

  async invalidateCard(cardId: string): Promise<boolean> {
    this.expireCard(this.now());
    if (this.card?.cardId !== cardId) return false;
    // Bug 根因：创建期发现加速 Provider 已从 Registry 下架时，卡仍留在服务里，Renderer 会继续
    // 锁定模型选择器。按事件携带的 cardId 作废当前卡，旧事件不能误删随后抽到的新卡；冷却时间不变。
    this.card = null;
    return true;
  }

  async getCurrentOwnerKey(): Promise<string | null> {
    return (await this.#resolveHealthyIdentity())?.ownerKey ?? null;
  }

  async healthy(cardId: string, ownerKey?: string): Promise<HighspeedCardUsage | null> {
    // 旧卡不能由当前登录认领；请求只使用归属一致的原子主身份快照。
    if (!ownerKey) return null;
    const identity = await this.#resolveHealthyIdentity();
    if (!identity || identity.ownerKey !== ownerKey) return null;
    const usage = await this.transport.healthy(cardId, {
      Authorization: `Bearer ${identity.zcodeJwt.replace(/^Bearer\s+/i, "")}`,
    });
    const current = await this.#resolveHealthyIdentity();
    return current?.sessionScope === identity.sessionScope && usage.cardId === cardId
      ? usage
      : null;
  }

  /**
   * 截止时间在进入 prepareTurn 时固定；计时器按需懒创建且只建一次，后续各段 await 复用，
   * automation / 无卡退役降级等同步路径不注册计时器。
   */
  private createSendBudget(startedAt: number, budgetMs: number): SendBudget {
    const deadline = startedAt + budgetMs;
    let expired: Promise<{ kind: "timeout" }> | null = null;
    return <T>(task: Promise<T>) => {
      expired ??= this.wait(Math.max(0, deadline - this.now())).then(() => ({
        kind: "timeout" as const,
      }));
      return Promise.race([task.then((value) => ({ kind: "settled" as const, value })), expired]);
    };
  }

  private authScope(auth: HighspeedInferenceAuth): string {
    // 仅保存在 Host 内存；包含会话 revision 的 accountScope 使同账号同 JWT 重登也可区分。
    return JSON.stringify([
      auth.accountScope,
      auth.zcodeJwt,
      auth.family,
      auth.codingPlanAuthorization,
      auth.targetType,
      auth.organizationId,
      auth.projectId,
    ]);
  }

  private clearCredentialState(): void {
    this.card = null;
    this.nextDrawAt = null;
    this.credentialScope = null;
  }

  private expireCard(now: number): void {
    if (this.card && this.card.expiresAt <= now) this.card = null;
  }

  private async prepareWithCard(
    card: HighspeedCardSnapshot,
    params: Pick<HighspeedPrepareTurnParams, "taskId" | "providerId" | "model" | "reasoningLevel">,
    withinBudget: SendBudget,
  ): Promise<HighspeedPrepareTurnResult> {
    if (card.taskId !== params.taskId) {
      return { kind: "fallback", reason: "foreign-card", card, nextDrawAt: this.nextDrawAt };
    }
    if (this.inferenceMode === "session-default") {
      return {
        kind: "accelerated",
        card,
        nextDrawAt: this.nextDrawAt ?? card.expiresAt,
      };
    }
    const auth = await withinBudget(this.#resolveInferenceAuth());
    // 鉴权解析超出预算：本轮普通发送，复用 draw-timeout 语义（「卡未能在预算内就绪」）；
    // 卡保留且随结果带回，下一轮鉴权就绪后直接复用加速。
    if (auth.kind === "timeout") {
      return { kind: "fallback", reason: "draw-timeout", card, nextDrawAt: this.nextDrawAt };
    }
    if (this.credentialScope !== this.authScope(auth.value) || this.card !== card) {
      if (this.card === card) this.clearCredentialState();
      return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
    }
    // 退回目标就是本次提交的会话选择（provider / model / 档位）：它与卡无关，也不依赖 CLI 运行态。
    const sessionSelection: ModelSelection = {
      providerId: params.providerId,
      modelId: params.model,
      ...(params.reasoningLevel ? { options: { reasoningLevel: params.reasoningLevel } } : {}),
    };
    return {
      kind: "accelerated",
      card,
      nextDrawAt: this.nextDrawAt ?? card.expiresAt,
      execution: buildHighspeedTurnExecution({ card, auth: auth.value, sessionSelection }),
    };
  }
}
