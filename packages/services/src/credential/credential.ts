import { ServiceChannels, credentialKeySchema } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 凭据管理服务
 *
 * 提供 key-value 形式的凭据读写。
 * 实现端（host process）负责加密存储细节，
 * 消费端（renderer）只通过 RPC 调用，不指定存储位置；确认恢复后可展示备份回执。
 */
export interface ICredentialService {
  /** 只读检测整份容器；不把普通 IO 错误或单字段解密失败当作损坏。 */
  inspectStore(): Promise<{ status: "healthy" } | { status: "corrupt"; fingerprint: string }>;
  /** 用户明确确认后提交损坏指纹；在原锁内备份、核验并重建，旧指纹只返回 changed。 */
  recoverStore(
    fingerprint: string,
  ): Promise<{ status: "changed" } | { status: "recovered"; backupPath: string }>;
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ICredentialService = createServiceDescriptor<ICredentialService>(
  ServiceChannels.Credential,
);

export function scopeCredentialServiceForRpc(
  service: ICredentialService,
  localDesktopRecovery: boolean,
): ICredentialService {
  function publicKey(raw: string): string {
    const key = credentialKeySchema.parse(raw);
    // 规范化必须先于私有域判断；所有客户端（含本机桌面）均不能通过通用 RPC 读取生图密钥。
    if (key.startsWith("image-generation."))
      throw Object.assign(new Error("Host private credential"), { code: "credential_private" });
    return key;
  }
  const rejectRecovery = async (): Promise<never> => {
    throw Object.assign(
      new Error("Credential store recovery is only available from local Desktop"),
      {
        kind: "feature_disabled" as const,
      },
    );
  };
  // clientMode 和可自领的 host ticket 都不是恢复授权。所有 RPC 默认只读写，
  // 唯一本机 Desktop MessagePort 发布点显式放行，避免新网络入口漏设限制。
  return {
    load: (key) => service.load(publicKey(key)),
    save: (key, value) => service.save(publicKey(key), value),
    delete: (key) => service.delete(publicKey(key)),
    inspectStore: localDesktopRecovery ? service.inspectStore.bind(service) : rejectRecovery,
    recoverStore: localDesktopRecovery ? service.recoverStore.bind(service) : rejectRecovery,
  };
}
