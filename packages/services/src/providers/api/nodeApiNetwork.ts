import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, WebSocket, fetch as undiciFetch, type Dispatcher } from "undici";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface HostApiNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  caCertPath?: string;
}

export interface HostWebSocketConnection {
  socket: WebSocket;
  /** 本次连接是否经 HTTP 代理（来自与 fetch 相同的选路结果） */
  viaProxy: boolean;
}

export interface HostApiNetworkTransport {
  fetch: typeof fetch;
  /**
   * 按与 fetch 相同的代理、No Proxy 与自定义 CA 建立 WebSocket（ws:// 按 http、wss:// 按 https 选路）。
   * 连接复用 fetch 的 dispatcher，transport 释放时随 dispatcher 一起关闭；配置无效时 fail-closed。
   */
  createWebSocket(url: string): Promise<HostWebSocketConnection>;
  /**
   * 生图专用出网：官方固定预设沿用 fetch 的系统代理/TLS 策略；自定义连接直连时只连接已校验的公网候选
   * 并保留原域名 TLS 校验，经代理且 Host 无法对等约束目标时 fail-closed。受控回环 fixture 仅由 Host 装配注入。
   */
  prepareImageGeneration?(
    endpoint: string,
    policy: { officialPreset: boolean; fixtureOrigin?: string; signal: AbortSignal },
  ): Promise<{ fetch(init: RequestInit): Promise<Response>; dispose(): void }>;
  dispose(): void;
  disposeAndWait(): Promise<void>;
}

type HostProxyRoute =
  | { kind: "direct"; noProxyMatched?: boolean }
  | { kind: "proxy"; proxyUrl: string }
  | { kind: "invalid"; reason: string };

export function mergeHostApiCaCertificates(
  customCa: string,
  defaultCa: readonly string[] = rootCertificates,
): string[] {
  // Node 的 tls.ca 会替换而不是追加默认根证书。只传企业代理 CA 会让未被
  // 中间人重签的公网证书失去信任链，因此必须同时保留 Node 默认根证书。
  return [...defaultCa, customCa];
}

function normalizeProxyUrl(value: string): string | undefined {
  const candidate = /^\w[\w+.-]*:\/\//.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function matchesNoProxy(url: URL, value: string | undefined): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return (value ?? "").split(/[\s,]+/).some((rawRule) => {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return true;

    const ruleWithoutScheme = rule.replace(/^[a-z][a-z\d+.-]*:\/\//, "");
    const [ruleHost = "", rulePort] = ruleWithoutScheme.split(":");
    const normalizedHost = ruleHost.replace(/^\*\.?/, "").replace(/^\./, "");
    if (!normalizedHost) return false;
    const hostMatches = host === normalizedHost || host.endsWith(`.${normalizedHost}`);
    return hostMatches && (!rulePort || rulePort === port);
  });
}

export function resolveHostProxyForUrl(
  requestUrl: string | URL,
  options: HostApiNetworkOptions,
): HostProxyRoute {
  let url: URL;
  try {
    url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  } catch {
    return { kind: "direct" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "direct" };
  }
  if (matchesNoProxy(url, options.noProxy)) {
    return { kind: "direct", noProxyMatched: true };
  }
  const configuredProxy = options.httpProxy?.trim();
  if (!configuredProxy) {
    return { kind: "direct" };
  }
  const proxyUrl = normalizeProxyUrl(configuredProxy);
  return proxyUrl
    ? { kind: "proxy", proxyUrl }
    : { kind: "invalid", reason: "Configured Host proxy URL is invalid" };
}

interface HostApiNetworkTransportDependencies {
  createDispatcher?: typeof createDispatcher;
  fetchWithDispatcher?: (
    input: string,
    init: Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
  ) => Promise<Response>;
  lookupHost?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return (
      a > 0 &&
      a < 224 &&
      ![10, 127].includes(a) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
      !(a === 203 && b === 0 && c === 113)
    );
  }
  // 保守仅允许全球单播分配，排除过渡、协议分配和文档地址；不把映射地址当作独立 IPv6 目的地。
  const [first, second] = address.toLowerCase().split(":");
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}$/.test(first ?? "") &&
    first !== "2002" &&
    first !== "3fff" &&
    !(first === "2001" && (second === "db8" || parseInt(second || "0", 16) < 0x200))
  );
}

function imageRouteError(code: "destination_blocked" | "proxy_unsupported") {
  return Object.assign(new Error("Image destination route is unavailable"), { code });
}

export function createHostApiNetworkTransport(
  resolveOptions: () => Promise<HostApiNetworkOptions>,
  dependencies: HostApiNetworkTransportDependencies = {},
): HostApiNetworkTransport {
  // Host 是独立 Node 进程，Electron Session.setProxy 不会影响它的 globalThis.fetch；
  // 在 NodeApiClient 出口按请求注入 dispatcher，避免把 telemetry 等其它裸 fetch 全局改道。
  let optionsPromise: Promise<HostApiNetworkOptions> | undefined;
  const dispatcherPromises = new Map<string, Promise<Dispatcher>>();
  let disposed = false;
  let generation = 0;
  let pendingDispatcherCreations = 0;
  let resolveDispatcherCreations: (() => void) | undefined;
  let dispatcherCreationsDone: Promise<void> | undefined;
  const lateDisposePromises: Promise<void>[] = [];
  let disposePromise: Promise<void> | undefined;
  let disposeMode: "close" | "destroy" | undefined;
  const dispatcherFactory = dependencies.createDispatcher ?? createDispatcher;
  const fetchWithDispatcher =
    dependencies.fetchWithDispatcher ??
    ((input, init) => undiciFetch(input, init as never) as unknown as Promise<Response>);

  const getOptions = () => {
    if (!optionsPromise) {
      // 设置读取失败只影响当前请求；清掉 rejected promise，避免一次瞬时 IPC/启动竞态
      // 把 Host API 永久锁死，同时仍保持失败请求不回退到直连。
      optionsPromise = resolveOptions().catch((error: unknown) => {
        optionsPromise = undefined;
        throw error;
      });
    }
    return optionsPromise;
  };
  const imageDispatchers = new Set<Dispatcher>();

  /**
   * 返回请求应使用的 dispatcher；dispatcher 为 undefined 表示直连且无自定义 CA，沿用默认网络栈。
   * viaProxy 是本次选路结果，调用方据此区分代理导致的失败，不再自行解析代理设置。
   */
  const resolveDispatcher = async (
    requestUrl: string,
  ): Promise<{ dispatcher?: Dispatcher; viaProxy: boolean }> => {
    if (disposed) {
      throw new Error("Host API network transport has been disposed");
    }
    const requestGeneration = generation;
    const options = await getOptions();
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    const route = resolveHostProxyForUrl(requestUrl, options);
    if (route.kind === "invalid") {
      throw new Error(route.reason);
    }
    if (route.kind === "direct" && !options.caCertPath) {
      return { viaProxy: false };
    }

    const dispatcherKey = `${route.kind}:${route.kind === "proxy" ? route.proxyUrl : "direct"}:${options.caCertPath ?? ""}`;
    let dispatcherPromise = dispatcherPromises.get(dispatcherKey);
    if (!dispatcherPromise) {
      if (disposed) {
        throw new Error("Host API network transport has been disposed");
      }
      const dispatcherGeneration = generation;
      pendingDispatcherCreations += 1;
      dispatcherPromise = dispatcherFactory(route, options.caCertPath);
      dispatcherPromises.set(dispatcherKey, dispatcherPromise);
      void dispatcherPromise
        .then((dispatcher) => {
          if (
            (disposed || generation !== dispatcherGeneration) &&
            dispatcherPromises.get(dispatcherKey) === dispatcherPromise
          ) {
            dispatcherPromises.delete(dispatcherKey);
            const cleanupPromise = Promise.resolve(
              disposeMode === "close" ? dispatcher.close() : dispatcher.destroy(),
            ).catch(() => {});
            lateDisposePromises.push(cleanupPromise);
          }
        })
        .catch(() => {});
      const markDispatcherCreationDone = () => {
        pendingDispatcherCreations -= 1;
        if (pendingDispatcherCreations === 0) {
          resolveDispatcherCreations?.();
          resolveDispatcherCreations = undefined;
        }
      };
      void dispatcherPromise.then(markDispatcherCreationDone, markDispatcherCreationDone);
      dispatcherPromise.catch(() => {
        // 设置/CA 等临时 IO 失败只影响当前请求；清理 rejected dispatcher，避免一次启动竞态
        // 把同一路由永久锁死，同时仍保持失败请求 fail-closed、不回退到直连。
        if (dispatcherPromises.get(dispatcherKey) === dispatcherPromise) {
          dispatcherPromises.delete(dispatcherKey);
        }
      });
    }
    const dispatcher = await dispatcherPromise;
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    return { dispatcher, viaProxy: route.kind === "proxy" };
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const { dispatcher } = await resolveDispatcher(requestUrl);
    if (!dispatcher) {
      return globalThis.fetch(input as Parameters<typeof fetch>[0], init);
    }
    return fetchWithDispatcher(
      input as unknown as string,
      {
        ...init,
        dispatcher,
      } as Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
    );
  };

  const startDispose = (mode: "close" | "destroy"): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    generation += 1;
    disposeMode = mode;
    // dispatcher 不能只被闭包缓存、没有 Host owner：窗口/远端 Host 重建后连接池和
    // keep-alive socket 仍可能存活。释放时对当前单飞 Promise 做快照，确保初始化中的 dispatcher
    // 也会在完成后被收口；同步退出 destroy，等待式退出 close。
    const pendingDispatchers = [...dispatcherPromises.values()];
    dispatcherPromises.clear();
    const pendingImageDispatchers = [...imageDispatchers];
    imageDispatchers.clear();
    if (pendingDispatcherCreations > 0) {
      dispatcherCreationsDone = new Promise<void>((resolve) => {
        resolveDispatcherCreations = resolve;
      });
    }
    disposePromise = (async () => {
      await Promise.allSettled(
        [...pendingDispatchers, ...pendingImageDispatchers].map(async (dispatcherPromise) => {
          const dispatcher = await dispatcherPromise;
          if (mode === "close") {
            await dispatcher.close();
          } else {
            await dispatcher.destroy();
          }
        }),
      );
      await dispatcherCreationsDone;
      await Promise.all(lateDisposePromises);
    })();
    return disposePromise;
  };

  // 自定义连接先校验实际选路与公网地址，再把可执行的单次请求交给发送屏障；不通过全局 agent 或重新解析。
  const prepareImageGeneration: NonNullable<
    HostApiNetworkTransport["prepareImageGeneration"]
  > = async (input, policy) => {
    policy.signal.throwIfAborted();
    const url = new URL(input);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const loopback =
      process.env.NODE_ENV !== "production" &&
      url.origin === policy.fixtureOrigin &&
      ["127.0.0.1", "::1"].includes(hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (!loopback && url.protocol !== "https:")
    ) {
      throw imageRouteError("destination_blocked");
    }
    let dispatcher: Dispatcher | undefined;
    let owned = false;
    let sent = false;
    if (loopback) {
      return {
        fetch: async (init) => {
          if (sent) throw imageRouteError("destination_blocked");
          sent = true;
          return globalThis.fetch(input, { ...init, redirect: "error", signal: policy.signal });
        },
        dispose() {},
      };
    }
    if (policy.officialPreset) {
      if (
        url.origin !== "https://api.openai.com" ||
        !["/v1/images/generations", "/v1/models"].includes(url.pathname)
      ) {
        throw imageRouteError("destination_blocked");
      }
      ({ dispatcher } = await resolveDispatcher(input));
    } else {
      const options = await getOptions();
      if (resolveHostProxyForUrl(url, options).kind !== "direct")
        throw imageRouteError("proxy_unsupported");
      const family = isIP(hostname);
      const entries = family
        ? [{ address: hostname, family }]
        : await (dependencies.lookupHost?.(hostname) ??
            dnsLookup(hostname, { all: true, order: "verbatim" }));
      if (
        !entries.length ||
        !entries.every(
          (entry) => entry.family === isIP(entry.address) && isPublicAddress(entry.address),
        )
      ) {
        throw imageRouteError("destination_blocked");
      }
      const customCa = options.caCertPath ? await readFile(options.caCertPath, "utf8") : undefined;
      policy.signal.throwIfAborted();
      if (disposed) throw new Error("Host API network transport has been disposed");
      dispatcher = new Agent({
        connect: {
          ...(customCa ? { ca: mergeHostApiCaCertificates(customCa) } : {}),
          // TLS 仍使用请求 URL 原域名；lookup 只返回这次已经校验过的连接候选。
          lookup: (_hostname, lookupOptions, callback) => {
            const requested =
              typeof lookupOptions === "object" ? lookupOptions : { family: lookupOptions };
            const matching =
              requested.family === 4 || requested.family === 6
                ? entries.filter((entry) => entry.family === requested.family)
                : entries;
            if (!matching.length) return callback(imageRouteError("destination_blocked"), "", 0);
            if ("all" in requested && requested.all) callback(null, matching as never);
            else callback(null, matching[0]!.address, matching[0]!.family);
          },
        },
      });
      imageDispatchers.add(dispatcher);
      owned = true;
    }
    return {
      async fetch(init) {
        if (disposed || sent) throw imageRouteError("destination_blocked");
        policy.signal.throwIfAborted();
        sent = true;
        const request = { ...init, redirect: "error" as const, signal: policy.signal };
        return dispatcher
          ? fetchWithDispatcher(input, { ...request, dispatcher })
          : globalThis.fetch(input, request);
      },
      dispose() {
        if (owned && dispatcher && imageDispatchers.delete(dispatcher))
          void dispatcher.destroy().catch(() => undefined);
      },
    };
  };

  // 修复原因：语音输入的 WebSocket 曾用 Node 全局 WebSocket 直连，绕过用户配置的代理和 CA，
  // 在只能经代理出网的环境里 ticket 能申请成功、音频连接却失败。改为与 fetch 共用选路和 dispatcher。
  const createWebSocket = async (url: string): Promise<HostWebSocketConnection> => {
    const routeUrl = new URL(url);
    if (routeUrl.protocol === "ws:") routeUrl.protocol = "http:";
    else if (routeUrl.protocol === "wss:") routeUrl.protocol = "https:";
    else throw new Error(`Unsupported WebSocket URL protocol: ${routeUrl.protocol}`);
    const { dispatcher, viaProxy } = await resolveDispatcher(routeUrl.href);
    const socket = dispatcher ? new WebSocket(url, { dispatcher }) : new WebSocket(url);
    return { socket, viaProxy };
  };

  return {
    fetch,
    createWebSocket,
    prepareImageGeneration,
    dispose() {
      void startDispose("destroy");
    },
    disposeAndWait() {
      return startDispose("close");
    },
  };
}

async function createDispatcher(
  route: Exclude<HostProxyRoute, { kind: "invalid" }>,
  caCertPath: string | undefined,
): Promise<Dispatcher> {
  const customCa = caCertPath ? await readFile(caCertPath, "utf8") : undefined;
  const ca = customCa ? mergeHostApiCaCertificates(customCa) : undefined;
  if (route.kind === "proxy") {
    return new ProxyAgent({
      uri: route.proxyUrl,
      proxyTls: ca ? { ca } : undefined,
      requestTls: ca ? { ca } : undefined,
    });
  }
  return new Agent({ connect: ca ? { ca } : undefined });
}
