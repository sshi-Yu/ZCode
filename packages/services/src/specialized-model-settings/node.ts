import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelSelection } from "@zcode/shared";
import { z } from "zod";
import type { ICredentialService } from "../credential/credential.js";
import { atomicWriteText, withAtomicFileLock } from "../fs/atomicFileUtils.js";
import {
  IMAGE_MODEL_PROTOCOLS,
  IMAGE_MODEL_QUALITIES,
  imageGenerationUrl,
  toolModelKey,
  type ImageModelSettingsView,
  type ISpecializedModelSettingsService,
  type ToolModelRef,
} from "./contract.js";

export const IMAGE_MODEL_CREDENTIAL_PREFIX = "specialized-image-model:";

const maxImageModels = 64;
const uuid = z.string().uuid();
const revision = z.number().int().nonnegative();
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[!-~]+$/);
const imageModel = z.strictObject({
  name: z.string().trim().min(1).max(100),
  modelId,
  protocol: z.enum(IMAGE_MODEL_PROTOCOLS),
  baseUrl: z.string().trim().min(1).max(2048),
  size: z
    .string()
    .trim()
    .regex(/^(?:|auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/),
  quality: z.union([z.literal(""), z.enum(IMAGE_MODEL_QUALITIES)]),
});
const savedImageModel = imageModel.extend({ id: uuid, secretRef: uuid.nullable() });
const toolModel = z.strictObject({
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
});
const storedSettings = z.strictObject({
  revision,
  models: z.array(savedImageModel).max(maxImageModels),
  defaultId: uuid.nullable(),
  utilityModel: toolModel.nullable().default(null),
  utilityRevision: revision.default(0),
  featureModel: toolModel.nullable().default(null),
  featureRevision: revision.default(0),
  gitModel: z.unknown().optional(),
});
const imageMutation = z.strictObject({ expectedRevision: revision, id: uuid });

export interface ExecutableFeatureModel extends ModelSelection {
  routeKey: string;
  endpointHost: string;
}

interface SpecializedModelSettingsOptions {
  filePath: string;
  credentials: Pick<ICredentialService, "save" | "delete" | "load">;
  readToolCandidates(): Promise<ToolModelRef[]>;
  readExecutableToolModels(): Promise<ModelSelection[]>;
  readFeatureCandidates(): Promise<ToolModelRef[]>;
  readExecutableFeatureModels(): Promise<ExecutableFeatureModel[]>;
}

type StoredSettings = Omit<z.infer<typeof storedSettings>, "gitModel">;

function fail(code: string): never {
  throw new Error(`specialized-model-settings.${code}`);
}

function credentialKey(ref: string): string {
  return `${IMAGE_MODEL_CREDENTIAL_PREFIX}${ref}`;
}

function canonicalBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("invalid-url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^https:\/\/[^/?#\s]+(?:\/[A-Za-z0-9_./~-]*)?$/.test(input) ||
    input.includes("\\") ||
    input.split("/").some((part) => part === "." || part === "..") ||
    url.pathname.includes("//") ||
    url.pathname.replace(/\/+$/, "").endsWith("/images/generations")
  ) {
    return fail("invalid-url");
  }
  return url.href.replace(/\/+$/, "");
}

function imageView(settings: StoredSettings): ImageModelSettingsView {
  return {
    revision: settings.revision,
    defaultId: settings.defaultId,
    models: settings.models.map(({ secretRef, ...model }) => ({
      ...model,
      configured: secretRef !== null,
      generationUrl: imageGenerationUrl(model.baseUrl),
    })),
  };
}

export function createSpecializedModelSettingsOwner(options: SpecializedModelSettingsOptions) {
  const { filePath, credentials } = options;

  async function read(): Promise<StoredSettings> {
    try {
      const { gitModel: _legacy, ...settings } = storedSettings.parse(
        JSON.parse(await readFile(filePath, "utf8")),
      );
      return settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return storedSettings.parse({ revision: 0, models: [], defaultId: null });
      }
      return fail("storage-unavailable");
    }
  }

  async function update<Result>(
    revisionKey: "revision" | "utilityRevision" | "featureRevision",
    expectedRevision: number,
    change: (settings: StoredSettings, persist: () => Promise<void>) => Promise<Result>,
  ): Promise<Result> {
    await mkdir(dirname(filePath), { recursive: true });
    return withAtomicFileLock(filePath, async () => {
      const settings = await read();
      if (settings[revisionKey] !== expectedRevision) return fail("revision-conflict");
      settings[revisionKey] += 1;
      return change(settings, () =>
        atomicWriteText(filePath, JSON.stringify(settings), { useFileLock: false }),
      );
    });
  }

  function toolSettingsView(settings: StoredSettings, candidates: ToolModelRef[]) {
    return {
      revision: settings.utilityRevision,
      selection: settings.utilityModel,
      candidates: candidates.map(({ providerId, modelId }) => ({ providerId, modelId })),
    };
  }

  function findCandidate<Candidate extends ToolModelRef>(
    candidates: Candidate[],
    selection: ToolModelRef,
  ) {
    const key = toolModelKey(selection);
    return candidates.find((entry) => toolModelKey(entry) === key);
  }

  async function featureView(settings: StoredSettings, candidates: ToolModelRef[]) {
    const selection = settings.featureModel;
    const executable =
      selection && findCandidate(await options.readExecutableFeatureModels(), selection);
    return {
      revision: settings.featureRevision,
      candidates,
      selection,
      available: Boolean(executable),
      routeKey: executable?.routeKey ?? null,
      endpointHost: executable?.endpointHost ?? null,
    };
  }

  return {
    async resolveImageModel(expectedRevision: number) {
      const settings = await read();
      if (settings.revision !== expectedRevision) return fail("revision-conflict");
      const saved = settings.models.find((model) => model.id === settings.defaultId);
      if (!saved?.secretRef) return fail("model-unavailable");
      const apiKey = await credentials.load(credentialKey(saved.secretRef));
      if (!apiKey) return fail("key-required");
      const { secretRef: _secretRef, ...model } = saved;
      return {
        ...model,
        generationUrl: imageGenerationUrl(canonicalBaseUrl(model.baseUrl)),
        apiKey,
      };
    },
    async resolveUtilityModel(): Promise<ModelSelection | null> {
      const { utilityModel } = await read();
      if (!utilityModel) return null;
      return findCandidate(await options.readExecutableToolModels(), utilityModel) ?? null;
    },
    async resolveFeatureModel(expectedRevision: number, expectedRouteKey: string) {
      const { featureModel, featureRevision } = await read();
      if (expectedRevision !== featureRevision) return fail("revision-conflict");
      if (!featureModel) return fail("model-unavailable");
      const executable = findCandidate(await options.readExecutableFeatureModels(), featureModel);
      if (!executable) return fail("model-unavailable");
      if (executable.routeKey !== expectedRouteKey) return fail("revision-conflict");
      const { routeKey: _routeKey, endpointHost: _endpointHost, ...selection } = executable;
      return selection;
    },
    createAttachmentService(): ISpecializedModelSettingsService {
      return {
        async getImageSettings() {
          return imageView(await read());
        },
        async saveImageModel(input) {
          const parsed = z
            .strictObject({
              expectedRevision: revision,
              id: uuid.optional(),
              model: imageModel,
              apiKey: z
                .string()
                .trim()
                .min(1)
                .max(4096)
                .regex(/^[!-~]+$/)
                .optional(),
            })
            .parse(input);
          const model = { ...parsed.model, baseUrl: canonicalBaseUrl(parsed.model.baseUrl) };
          return update("revision", parsed.expectedRevision, async (settings, persist) => {
            const previous = settings.models.find((item) => item.id === parsed.id);
            if (parsed.id && !previous) return fail("model-unavailable");
            if (!previous && settings.models.length >= maxImageModels) return fail("model-limit");
            if (
              previous?.secretRef &&
              !parsed.apiKey &&
              imageGenerationUrl(previous.baseUrl) !== imageGenerationUrl(model.baseUrl)
            ) {
              return fail("key-required");
            }
            const freshRef = parsed.apiKey ? randomUUID() : null;
            const saved = {
              ...model,
              id: previous?.id ?? randomUUID(),
              secretRef: freshRef ?? previous?.secretRef ?? null,
            };
            if (parsed.apiKey && freshRef)
              await credentials.save(credentialKey(freshRef), parsed.apiKey);
            settings.models = previous
              ? settings.models.map((item) => (item.id === previous.id ? saved : item))
              : [...settings.models, saved];
            settings.defaultId ??= saved.id;
            try {
              await persist();
            } catch (error) {
              if (freshRef)
                await credentials.delete(credentialKey(freshRef)).catch(() => undefined);
              throw error;
            }
            if (freshRef && previous?.secretRef) {
              await credentials.delete(credentialKey(previous.secretRef)).catch(() => undefined);
            }
            return imageView(settings);
          });
        },
        async deleteImageModel(input) {
          const parsed = imageMutation.parse(input);
          return update("revision", parsed.expectedRevision, async (settings, persist) => {
            const model = settings.models.find((item) => item.id === parsed.id);
            if (!model) return fail("model-unavailable");
            settings.models = settings.models.filter((item) => item.id !== model.id);
            if (settings.defaultId === model.id)
              settings.defaultId = settings.models[0]?.id ?? null;
            await persist();
            if (model.secretRef)
              await credentials.delete(credentialKey(model.secretRef)).catch(() => undefined);
            return imageView(settings);
          });
        },
        async setDefaultImageModel(input) {
          const parsed = imageMutation.parse(input);
          return update("revision", parsed.expectedRevision, async (settings, persist) => {
            if (!settings.models.some((model) => model.id === parsed.id))
              return fail("model-unavailable");
            settings.defaultId = parsed.id;
            await persist();
            return imageView(settings);
          });
        },
        async getToolModelSettings() {
          const [settings, candidates] = await Promise.all([read(), options.readToolCandidates()]);
          return toolSettingsView(settings, candidates);
        },
        async setToolModel(input) {
          const parsed = z
            .strictObject({ expectedRevision: revision, selection: toolModel.nullable() })
            .parse(input);
          return update("utilityRevision", parsed.expectedRevision, async (settings, persist) => {
            const candidates = await options.readToolCandidates();
            if (parsed.selection && !findCandidate(candidates, parsed.selection))
              return fail("model-unavailable");
            settings.utilityModel = parsed.selection;
            await persist();
            return toolSettingsView(settings, candidates);
          });
        },
        async getFeatureModelSettings() {
          const [settings, candidates] = await Promise.all([
            read(),
            options.readFeatureCandidates(),
          ]);
          return featureView(settings, candidates);
        },
        async setFeatureModel(input) {
          const parsed = z
            .strictObject({ expectedRevision: revision, selection: toolModel.nullable() })
            .parse(input);
          return update("featureRevision", parsed.expectedRevision, async (settings, persist) => {
            const candidates = await options.readFeatureCandidates();
            if (parsed.selection && !findCandidate(candidates, parsed.selection))
              return fail("model-unavailable");
            settings.featureModel = parsed.selection;
            const view = await featureView(settings, candidates);
            await persist();
            return view;
          });
        },
      };
    },
  };
}
