import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MockAgent } from "undici";
import { PNG } from "pngjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const { tsImport } = require("tsx/esm/api") as typeof import("tsx/esm/api");

export async function runGenImageSyncReplay() {
  const { createGenImageService } = (await tsImport(
    pathToFileURL(join(root, "services/src/genimage/node.ts")).href,
    import.meta.url,
  )) as Pick<typeof import("@zcode/services/node"), "createGenImageService">;
  const { decodeGeneratedImage } = await tsImport(
    pathToFileURL(join(root, "services/src/genimage/image.ts")).href,
    import.meta.url,
  );
  const { buildImageGenerationBody, generateRemoteImage } = await tsImport(
    pathToFileURL(join(root, "services/src/genimage/adapter.ts")).href,
    import.meta.url,
  );
  const { createSpecializedModelSettingsOwner } = await tsImport(
    pathToFileURL(join(root, "services/src/specialized-model-settings/node.ts")).href,
    import.meta.url,
  );
  const directory = await mkdtemp(join(tmpdir(), "zcode-genimage-sync-replay-"));
  try {
    const png = new PNG({ width: 64, height: 48 });
    png.data.fill(120);
    const original = PNG.sync.write(png);
    const decoded = await decodeGeneratedImage(original.toString("base64"));
    assert.equal(decoded.width, 64);
    assert.equal(decoded.height, 48);
    assert.deepEqual(decoded.original, original);
    await assert.rejects(decodeGeneratedImage("not an image"), /response-invalid/);
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    await assert.rejects(decodeGeneratedImage(corrupted.toString("base64")), /response-invalid/);
    const model = {
      id: randomUUID(),
      name: "Replay image",
      modelId: "fixture",
      protocol: "openai" as const,
      baseUrl: "https://images.example.invalid/v1",
      generationUrl: "https://images.example.invalid/v1/images/generations",
      apiKey: "fixture-key",
      size: "1024x1024",
      quality: "high" as const,
    };
    assert.deepEqual(buildImageGenerationBody(model, "replay"), {
      model: "fixture",
      prompt: "replay",
      n: 1,
      size: "1024x1024",
      quality: "high",
    });
    assert.equal(
      buildImageGenerationBody({ ...model, protocol: "base64" }, "replay").response_format,
      "b64_json",
    );
    const replay = new MockAgent();
    replay.disableNetConnect();
    const pool = replay.get("https://images.example.invalid");
    pool
      .intercept({
        path: "/v1/images/generations",
        method: "POST",
        body: JSON.stringify(buildImageGenerationBody(model, "replay")),
        headers: { authorization: "Bearer fixture-key", "content-type": "application/json" },
      })
      .reply(200, { data: [{ b64_json: original.toString("base64") }] });
    const transport = {
      resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      createDispatcher: () => replay,
    };
    const received = await generateRemoteImage(model, "replay", transport);
    assert.deepEqual(received.original, original);
    replay.assertNoPendingInterceptors();
    const compatibility = new MockAgent();
    compatibility.disableNetConnect();
    compatibility
      .get("https://images.example.invalid")
      .intercept({
        path: "/v1/images/generations",
        method: "POST",
        body: JSON.stringify(buildImageGenerationBody({ ...model, protocol: "base64" }, "replay")),
      })
      .reply(200, { data: [{ b64_json: original.toString("base64") }] });
    await generateRemoteImage({ ...model, protocol: "base64" }, "replay", {
      ...transport,
      createDispatcher: () => compatibility,
    });
    compatibility.assertNoPendingInterceptors();
    const secrets = new Map<string, string>();
    const originalRoute = "1".repeat(64);
    const replacementRoute = "2".repeat(64);
    let featureRouteKey = originalRoute;
    const owner = createSpecializedModelSettingsOwner({
      filePath: join(directory, "settings.json"),
      credentials: {
        save: async (key: string, value: string) => {
          secrets.set(key, value);
        },
        delete: async (key: string) => {
          secrets.delete(key);
        },
        load: async (key: string) => secrets.get(key) ?? null,
      },
      readToolCandidates: async () => [],
      readExecutableToolModels: async () => [],
      readFeatureCandidates: async () => [{ providerId: "fixture-vision", modelId: "fixture" }],
      readExecutableFeatureModels: async () => [
        {
          providerId: "fixture-vision",
          modelId: "fixture",
          routeKey: featureRouteKey,
          endpointHost: "vision.example.invalid",
        },
      ],
    });
    const attachment = owner.createAttachmentService();
    const saved = await attachment.saveImageModel({
      expectedRevision: 0,
      model: {
        name: model.name,
        modelId: model.modelId,
        protocol: model.protocol,
        baseUrl: model.baseUrl,
        size: model.size,
        quality: model.quality,
      },
      apiKey: model.apiKey,
    });
    assert.equal(saved.models[0].configured, true);
    assert(!JSON.stringify(saved).includes(model.apiKey));
    assert(!("resolveImageModel" in attachment));
    await assert.rejects(owner.resolveImageModel(0), /revision-conflict/);
    assert.equal((await owner.resolveImageModel(saved.revision)).apiKey, model.apiKey);
    const feature = await attachment.setFeatureModel({
      expectedRevision: 0,
      selection: { providerId: "fixture-vision", modelId: "fixture" },
    });
    assert.equal(feature.available, true);
    assert.equal((await attachment.getToolModelSettings()).revision, 0);
    assert.equal(feature.routeKey, originalRoute);
    await assert.rejects(owner.resolveFeatureModel(0, originalRoute), /revision-conflict/);
    await assert.rejects(
      owner.resolveFeatureModel(feature.revision, replacementRoute),
      /revision-conflict/,
    );
    assert.deepEqual(await owner.resolveFeatureModel(feature.revision, originalRoute), {
      providerId: "fixture-vision",
      modelId: "fixture",
    });
    for (const [status, code] of [
      [401, "authentication"],
      [429, "quota"],
      [500, "result-unknown"],
      [302, "result-unknown"],
    ] as const) {
      const rejected = new MockAgent();
      rejected.disableNetConnect();
      rejected
        .get("https://images.example.invalid")
        .intercept({ path: "/v1/images/generations", method: "POST" })
        .reply(status, { error: "fixture only" });
      await assert.rejects(
        generateRemoteImage(model, "replay", { ...transport, createDispatcher: () => rejected }),
        new RegExp(code),
      );
    }
    await assert.rejects(
      generateRemoteImage(
        { ...model, generationUrl: "https://127.0.0.1/v1/images/generations" },
        "replay",
      ),
      /destination-unavailable/,
    );
    let featureCalls = 0;
    let featureRevision = 0;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const featureSelection = { providerId: "fixture-vision", modelId: "fixture" };
    const importScope = "import-project";
    const importedId = randomUUID();
    const assets = createGenImageService({
      dataDir: join(directory, "assets"),
      createPreviewUrl: async (path: string) => path,
      resolveFeatureModel: async (revision, routeKey) => {
        if (revision !== featureRevision || routeKey !== featureRouteKey)
          throw new Error("specialized-model-settings.revision-conflict");
        return featureSelection;
      },
      extractImageFeatures: async ({ image, routeKey }) => {
        assert.equal(routeKey, featureRouteKey);
        assert.equal(PNG.sync.read(Buffer.from(image)).width, 64);
        featureCalls += 1;
        if (featureCalls === 2) {
          started.resolve();
          await finish.promise;
        }
        return { summary: "A test image", tags: ["gradient", "color"] };
      },
    });
    const importInput = {
      scope: importScope,
      requestId: importedId,
      name: "fixture.png",
      bytes: original,
      x: 0,
      y: 0,
    };
    await assets.importAsset(importInput);
    await assets.importAsset(importInput);
    assert.equal((await assets.getBoard({ scope: importScope })).nodes.length, 1);
    assert.deepEqual(
      Buffer.from(await assets.readOriginal({ scope: importScope, nodeId: importedId })),
      original,
    );
    await assert.rejects(assets.readOriginal({ scope: "other", nodeId: importedId }));
    await assert.rejects(
      assets.importAsset({ ...importInput, requestId: randomUUID(), bytes: corrupted }),
    );
    assert.equal(featureCalls, 0);
    const featureRequest = {
      scope: importScope,
      nodeId: importedId,
      modelRevision: 0,
      routeKey: originalRoute,
      requestId: randomUUID(),
    };
    const extracted = await assets.extractFeatures(featureRequest);
    assert.deepEqual(extracted.nodes[0]!.features?.tags, ["gradient", "color"]);
    await assets.extractFeatures({ ...featureRequest, requestId: randomUUID() });
    assert.equal(featureCalls, 1);
    const duplicateId = randomUUID();
    const duplicate = await assets.importAsset({ ...importInput, requestId: duplicateId, x: 400 });
    assert.deepEqual(
      duplicate.nodes.find(({ id }) => id === duplicateId)?.features,
      extracted.nodes[0]!.features,
    );
    featureRevision = 1;
    const nextRequest = {
      ...featureRequest,
      requestId: randomUUID(),
      modelRevision: featureRevision,
    };
    const pendingFeature = assets.extractFeatures(nextRequest);
    const stale = assert.rejects(pendingFeature, /revision-conflict/);
    await started.promise;
    try {
      await assert.rejects(
        assets.extractFeatures({ ...nextRequest, nodeId: duplicateId, requestId: randomUUID() }),
        /feature-busy/,
      );
      featureRouteKey = replacementRoute;
      await assert.rejects(
        assets.extractFeatures({ ...nextRequest, requestId: randomUUID() }),
        /revision-conflict/,
      );
      assert.deepEqual(
        (await assets.getBoard({ scope: importScope })).nodes[0]!.features,
        extracted.nodes[0]!.features,
      );
      const refreshed = await assets.extractFeatures({
        ...nextRequest,
        requestId: randomUUID(),
        routeKey: replacementRoute,
      });
      assert(refreshed.nodes.every(({ features }) => features?.routeKey === replacementRoute));
    } finally {
      finish.resolve();
    }
    await stale;
    assert.equal(featureCalls, 3);
    const current = await assets.getBoard({ scope: importScope });
    assert(current.nodes.every(({ features }) => features?.routeKey === replacementRoute));

    const jpeg = Buffer.from(
      [
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIx",
        "wcKDcpLDAxNDQ0Hyc5PTgyPC4zNDIBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy",
        "MjIyMjIyMjIyMjIyMjIyMjIyMv/AABEIAAIAAwMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBw",
        "gJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYn",
        "KCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqa",
        "qys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAEC",
        "AwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04S",
        "XxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqi",
        "o6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AP",
        "SKAP8A/9k=",
      ].join(""),
      "base64",
    );
    const jpegId = randomUUID();
    await assets.importAsset({
      ...importInput,
      requestId: jpegId,
      name: "fixture.jpg",
      bytes: jpeg,
    });
    const jpegOriginal = await assets.getAsset({
      scope: importScope,
      nodeId: jpegId,
      variant: "original",
    });
    assert.equal(jpegOriginal.mimeType, "image/jpeg");
    assert.deepEqual(
      Buffer.from(await assets.readOriginal({ scope: importScope, nodeId: jpegId })),
      jpeg,
    );
    const jpegThumb = await assets.getAsset({
      scope: importScope,
      nodeId: jpegId,
      variant: "thumbnail",
    });
    assert.equal(jpegThumb.mimeType, "image/png");
    const thumbnail = PNG.sync.read(await readFile(jpegThumb.url));
    assert.deepEqual([thumbnail.width, thumbnail.height], [3, 2]);
    let calls = 0;
    const options = {
      dataDir: join(directory, "live"),
      createPreviewUrl: async (path: string) => path,
      resolveModel: async (revision: number) => {
        assert.equal(revision, 7);
        return model;
      },
      generateImage: async () => {
        calls += 1;
        return decoded;
      },
    };
    const first = createGenImageService(options);
    const second = createGenImageService(options);
    const input = {
      scope: " replay-project ",
      modelRevision: 7,
      requestId: randomUUID(),
      prompt: "E2E_GENIMAGE_SYNC",
      x: 0,
      y: 0,
    };
    const results = await Promise.allSettled([first.generate(input), second.generate(input)]);
    assert(results.some((result) => result.status === "fulfilled"));
    assert.equal(calls, 1);
    const board = await second.getBoard({ scope: "replay-project" });
    assert.equal(board.nodes.length, 1);
    assert.equal(board.nodes[0]!.modelName, model.name);
    assert.deepEqual(
      Buffer.from(
        await second.readOriginal({
          scope: "replay-project",
          nodeId: input.requestId,
        }),
      ),
      original,
    );
    assert.equal((await second.getBoard({ scope: "other" })).nodes.length, 0);
    await second.generate(input);
    assert.equal(calls, 1);
    await assert.rejects(second.generate({ ...input, prompt: "changed" }), /request-conflict/);
    const pending = { ...input, requestId: randomUUID(), prompt: "E2E_GENIMAGE_UNKNOWN" };
    const failing = createGenImageService({
      ...options,
      generateImage: async () => {
        calls += 1;
        throw new Error("genimage.result-unknown");
      },
    });
    await assert.rejects(failing.generate(pending), /result-unknown/);
    const restarted = createGenImageService(options);
    await assert.rejects(restarted.generate(pending), /result-unknown/);
    assert.equal(calls, 2);
    assert.equal((await restarted.getBoard({ scope: input.scope })).unconfirmed, 1);
    const boards = await readdir(join(directory, "live"));
    const manifest = await readFile(join(directory, "live", boards[0]!, "board.json"), "utf8");
    assert(!manifest.includes(model.apiKey));
    return { adapterCalls: calls, completed: 1, unconfirmed: 1, originalBytes: original.length };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (typeof describe === "function") {
  describe("GENIMAGE-SYNC zero-quota runtime replay", () => {
    it("validates request and image contracts, persistence, isolation and no resend", async () => {
      await runGenImageSyncReplay();
    });
  });
} else {
  void runGenImageSyncReplay().then((result) =>
    process.stdout.write(`${JSON.stringify(result)}\n`),
  );
}
