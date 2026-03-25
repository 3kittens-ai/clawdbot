import { Type } from "@sinclair/typebox";
import {
  ToolInputError,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postJsonRequest,
} from "openclaw/plugin-sdk/media-understanding";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeGoogleModelId, parseGeminiAuth } from "openclaw/plugin-sdk/provider-google";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";

const DEFAULT_PRIMARY_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_FALLBACK_MODEL = "google/gemini-3-pro-image-preview";
const DEFAULT_GOOGLE_IMAGE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MAX_COUNT = 4;
const MAX_INPUT_IMAGES = 5;
const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

type GeminiImagePluginConfig = {
  model?: string;
  fallbackModel?: string;
};

type GeminiToolAction = "generate" | "edit" | "describe" | "list";

type GeminiInlineData = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

type GeminiPart = {
  text?: string;
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
};

const GeminiImageToolSchema = Type.Object(
  {
    action: Type.Optional(
      Type.String({
        description: 'Optional action: "generate", "edit", "describe", or "list".',
      }),
    ),
    prompt: Type.String({
      description: "Prompt for Gemini image generation, image editing, or image description.",
    }),
    image: Type.Optional(
      Type.String({
        description:
          "Optional reference image path/URL. For channel image edits, pass the attachment path from the current message.",
      }),
    ),
    images: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Optional reference image paths/URLs for multi-image edits. Use current-message attachment paths when available.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Optional Gemini model override. Accepts either provider/model or a bare Gemini model id.",
      }),
    ),
    grounded: Type.Optional(
      Type.Boolean({
        description: "Enable Gemini googleSearch grounding for native Gemini requests.",
      }),
    ),
    size: Type.Optional(
      Type.String({
        description:
          "Optional size hint like 1024x1024, 1536x1024, 1024x1536, 1024x1792, or 1792x1024.",
      }),
    ),
    aspectRatio: Type.Optional(
      Type.String({
        description:
          "Optional aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9.",
      }),
    ),
    resolution: Type.Optional(
      Type.String({
        description: "Optional output resolution: 1K, 2K, or 4K.",
      }),
    ),
    count: Type.Optional(
      Type.Number({
        description: `Optional number of output images (1-${MAX_COUNT}).`,
        minimum: 1,
        maximum: MAX_COUNT,
      }),
    ),
    filename: Type.Optional(
      Type.String({
        description: "Optional output filename hint for the saved image.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Optional timeout in seconds for native Gemini requests.",
        minimum: 1,
      }),
    ),
    maxTokens: Type.Optional(
      Type.Number({
        description: "Optional max tokens for describe responses.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

function normalizeGeminiModelRef(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed.includes("/")) {
    return trimmed;
  }
  return `google/${trimmed}`;
}

function buildGeminiImageConfig(
  apiConfig: OpenClawPluginApi["config"],
  pluginConfig: GeminiImagePluginConfig | undefined,
  requestedModel: string | undefined,
) {
  const primary = normalizeGeminiModelRef(
    requestedModel ?? pluginConfig?.model,
    DEFAULT_PRIMARY_MODEL,
  );
  const fallback = normalizeGeminiModelRef(pluginConfig?.fallbackModel, DEFAULT_FALLBACK_MODEL);
  return {
    ...(apiConfig ?? {}),
    agents: {
      ...(apiConfig?.agents ?? {}),
      defaults: {
        ...(apiConfig?.agents?.defaults ?? {}),
        imageGenerationModel: {
          primary,
          fallbacks: fallback === primary ? [] : [fallback],
        },
      },
    },
  };
}

function normalizeImageInputs(rawParams: Record<string, unknown>): string[] {
  const values = [
    readStringParam(rawParams, "image"),
    ...(readStringArrayParam(rawParams, "images") ?? []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }

  if (unique.length > MAX_INPUT_IMAGES) {
    throw new ToolInputError(
      `Too many reference images: ${unique.length} provided, maximum is ${MAX_INPUT_IMAGES}.`,
    );
  }

  return unique;
}

function resolveAction(
  rawParams: Record<string, unknown>,
  imageInputs: string[],
): GeminiToolAction {
  const raw = readStringParam(rawParams, "action");
  if (!raw) {
    return imageInputs.length > 0 ? "edit" : "generate";
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "generate" ||
    normalized === "edit" ||
    normalized === "describe" ||
    normalized === "list"
  ) {
    return normalized;
  }
  throw new ToolInputError('action must be "generate", "edit", "describe", or "list"');
}

function normalizeResolution(raw: string | undefined): "1K" | "2K" | "4K" | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1K" || normalized === "2K" || normalized === "4K") {
    return normalized;
  }
  throw new ToolInputError("resolution must be one of 1K, 2K, or 4K");
}

function normalizeAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError(
    "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9",
  );
}

function normalizeOptionalSize(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

function normalizeCount(rawParams: Record<string, unknown>): number {
  const count = readNumberParam(rawParams, "count", { integer: true });
  if (count === undefined) {
    return 1;
  }
  if (count < 1 || count > MAX_COUNT) {
    throw new ToolInputError(`count must be between 1 and ${MAX_COUNT}`);
  }
  return count;
}

function normalizeTimeoutMs(rawParams: Record<string, unknown>): number {
  const seconds = readNumberParam(rawParams, "timeoutSeconds");
  if (seconds === undefined) {
    return 60_000;
  }
  if (seconds <= 0) {
    throw new ToolInputError("timeoutSeconds must be greater than 0");
  }
  return Math.floor(seconds * 1000);
}

function normalizeMaxTokens(rawParams: Record<string, unknown>): number | undefined {
  const value = readNumberParam(rawParams, "maxTokens", { integer: true });
  if (value === undefined) {
    return undefined;
  }
  if (value <= 0) {
    throw new ToolInputError("maxTokens must be greater than 0");
  }
  return value;
}

async function loadReferenceImages(images: string[]) {
  const loaded = await Promise.all(
    images.map(async (source) => {
      const media = await loadWebMedia(source);
      if (media.kind !== "image") {
        throw new ToolInputError(
          `Unsupported media type for ${source}: ${media.kind ?? "unknown"}`,
        );
      }
      return {
        source,
        buffer: media.buffer,
        mimeType: media.contentType ?? "image/png",
      };
    }),
  );

  return loaded;
}

function resolveGoogleBaseUrl(cfg: OpenClawPluginApi["config"]): string {
  return normalizeBaseUrl(
    cfg?.models?.providers?.google?.baseUrl?.trim(),
    DEFAULT_GOOGLE_IMAGE_BASE_URL,
  );
}

function mapSizeToImageConfig(
  size: string | undefined,
): { aspectRatio?: string; imageSize?: "2K" | "4K" } | undefined {
  const trimmed = size?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  const mapping = new Map<string, string>([
    ["1024x1024", "1:1"],
    ["1024x1536", "2:3"],
    ["1536x1024", "3:2"],
    ["1024x1792", "9:16"],
    ["1792x1024", "16:9"],
  ]);
  const aspectRatio = mapping.get(normalized);
  const [widthRaw, heightRaw] = normalized.split("x");
  const width = Number.parseInt(widthRaw ?? "", 10);
  const height = Number.parseInt(heightRaw ?? "", 10);
  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge >= 3072 ? "4K" : longestEdge >= 1536 ? "2K" : undefined;

  if (!aspectRatio && !imageSize) {
    return undefined;
  }

  return {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  };
}

function collectParts(payload: GeminiGenerateContentResponse): GeminiPart[] {
  return (payload.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? []);
}

function collectText(parts: GeminiPart[]): string {
  return parts
    .map((part) => part.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

function collectImages(parts: GeminiPart[]) {
  let imageIndex = 0;
  return parts
    .map((part) => {
      const inline = part.inlineData ?? part.inline_data;
      const data = inline?.data?.trim();
      if (!data) {
        return null;
      }
      const mimeType = inline?.mimeType ?? inline?.mime_type ?? "image/png";
      const extension = mimeType.includes("jpeg") ? "jpg" : (mimeType.split("/")[1] ?? "png");
      imageIndex += 1;
      return {
        buffer: Buffer.from(data, "base64"),
        mimeType,
        fileName: `image-${imageIndex}.${extension}`,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function createNativeCandidates(params: {
  requestedModel?: string;
  pluginConfig?: GeminiImagePluginConfig;
}): string[] {
  const primary = normalizeGeminiModelRef(
    params.requestedModel ?? params.pluginConfig?.model,
    DEFAULT_PRIMARY_MODEL,
  );
  const fallback = normalizeGeminiModelRef(
    params.pluginConfig?.fallbackModel,
    DEFAULT_FALLBACK_MODEL,
  );
  return [...new Set([primary, fallback])];
}

async function runNativeGeminiRequest(params: {
  api: OpenClawPluginApi;
  prompt: string;
  action: Exclude<GeminiToolAction, "list">;
  requestedModel?: string;
  grounded: boolean;
  timeoutMs: number;
  size?: string;
  aspectRatio?: string;
  resolution?: "1K" | "2K" | "4K";
  maxTokens?: number;
  inputImages: Array<{ buffer: Buffer; mimeType: string; source: string }>;
  pluginConfig?: GeminiImagePluginConfig;
}) {
  const candidates =
    params.action === "describe"
      ? [
          normalizeGeminiModelRef(
            params.requestedModel ?? params.pluginConfig?.model,
            DEFAULT_PRIMARY_MODEL,
          ),
        ]
      : createNativeCandidates({
          requestedModel: params.requestedModel,
          pluginConfig: params.pluginConfig,
        });

  const auth = await params.api.runtime.modelAuth.resolveApiKeyForProvider({
    provider: "google",
    cfg: params.api.config,
  });
  if (!auth.apiKey) {
    throw new Error("Google API key missing");
  }

  const baseUrl = resolveGoogleBaseUrl(params.api.config);
  const allowPrivateNetwork = Boolean(
    params.api.config?.models?.providers?.google?.baseUrl?.trim(),
  );
  const authHeaders = parseGeminiAuth(auth.apiKey);

  let lastError: unknown;
  const attempts: Array<{ provider: string; model: string; error: string }> = [];

  for (const candidate of candidates) {
    const model = normalizeGoogleModelId(candidate.replace(/^google\//, ""));
    const headers = new Headers(authHeaders.headers);
    const imageConfig = {
      ...mapSizeToImageConfig(params.size),
      ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
      ...(params.resolution ? { imageSize: params.resolution } : {}),
    };
    const body: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [
            ...params.inputImages.map((image) => ({
              inlineData: {
                mimeType: image.mimeType,
                data: image.buffer.toString("base64"),
              },
            })),
            { text: params.prompt },
          ],
        },
      ],
    };

    if (params.grounded) {
      body.tools = [{ googleSearch: {} }];
    }

    if (params.action !== "describe") {
      body.generationConfig = {
        responseModalities: ["TEXT", "IMAGE"],
        ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
      };
    } else if (params.maxTokens) {
      body.generationConfig = {
        maxOutputTokens: params.maxTokens,
      };
    }

    const { response, release } = await postJsonRequest({
      url: `${baseUrl}/models/${model}:generateContent`,
      headers,
      body,
      timeoutMs: params.timeoutMs,
      fetchFn: fetch,
      allowPrivateNetwork,
    });

    try {
      await assertOkOrThrowHttpError(response, "Gemini image request failed");
      const payload = (await response.json()) as GeminiGenerateContentResponse;
      const parts = collectParts(payload);
      const text = collectText(parts);
      const images = collectImages(parts);

      if (params.action === "describe") {
        if (!text) {
          throw new Error("Gemini describe response missing text");
        }
        return { provider: "google", model, text, images: [], attempts };
      }

      if (images.length > 0) {
        return { provider: "google", model, text, images, attempts };
      }

      throw new Error(`Model \`${model}\` returned no image data.`);
    } catch (error) {
      lastError = error;
      attempts.push({
        provider: "google",
        model,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await release();
    }
  }

  const summary =
    attempts.length > 0
      ? attempts.map((item) => `${item.model}: ${item.error}`).join(" | ")
      : lastError instanceof Error
        ? lastError.message
        : String(lastError);
  throw new Error(`All Gemini image attempts failed: ${summary}`);
}

export function createGeminiImageTool(api: OpenClawPluginApi) {
  const pluginConfig =
    api.pluginConfig && typeof api.pluginConfig === "object" && !Array.isArray(api.pluginConfig)
      ? (api.pluginConfig as GeminiImagePluginConfig)
      : undefined;

  return {
    name: "gemini_image",
    label: "Gemini Image",
    description:
      'Generate, edit, or describe images with Gemini for messaging workflows. Use action="describe" to analyze attached images. Use grounded=true when you want Gemini native googleSearch grounding.',
    parameters: GeminiImageToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const imageInputs = normalizeImageInputs(rawParams);
      const action = resolveAction(rawParams, imageInputs);

      if (action === "edit" && imageInputs.length === 0) {
        throw new ToolInputError('action "edit" requires at least one image');
      }
      if (action === "describe" && imageInputs.length === 0) {
        throw new ToolInputError('action "describe" requires at least one image');
      }

      if (action === "list") {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Gemini image actions: generate, edit, describe, list.",
                `Primary model: ${normalizeGeminiModelRef(pluginConfig?.model, DEFAULT_PRIMARY_MODEL)}`,
                `Fallback model: ${normalizeGeminiModelRef(pluginConfig?.fallbackModel, DEFAULT_FALLBACK_MODEL)}`,
                "Native Gemini options: grounded, timeoutSeconds, size, aspectRatio, resolution, maxTokens.",
              ].join("\n"),
            },
          ],
          details: {
            actions: ["generate", "edit", "describe", "list"],
            primaryModel: normalizeGeminiModelRef(pluginConfig?.model, DEFAULT_PRIMARY_MODEL),
            fallbackModel: normalizeGeminiModelRef(
              pluginConfig?.fallbackModel,
              DEFAULT_FALLBACK_MODEL,
            ),
          },
        };
      }

      const prompt = readStringParam(rawParams, "prompt", { required: true });
      const model = readStringParam(rawParams, "model");
      const filename = readStringParam(rawParams, "filename");
      const grounded = rawParams.grounded === true;
      const size = normalizeOptionalSize(readStringParam(rawParams, "size"));
      const aspectRatio = normalizeAspectRatio(readStringParam(rawParams, "aspectRatio"));
      const resolution = normalizeResolution(readStringParam(rawParams, "resolution"));
      const timeoutMs = normalizeTimeoutMs(rawParams);
      const maxTokens = normalizeMaxTokens(rawParams);
      const count = normalizeCount(rawParams);
      const inputImages = await loadReferenceImages(imageInputs);

      if (action === "describe" || grounded) {
        const nativeResult = await runNativeGeminiRequest({
          api,
          prompt,
          action,
          requestedModel: model,
          grounded,
          timeoutMs,
          size,
          aspectRatio,
          resolution,
          maxTokens,
          inputImages,
          pluginConfig,
        });

        if (action === "describe") {
          return {
            content: [{ type: "text" as const, text: nativeResult.text }],
            details: {
              provider: nativeResult.provider,
              model: nativeResult.model,
              prompt,
              ...(imageInputs.length === 1 ? { image: imageInputs[0] } : { images: imageInputs }),
            },
          };
        }

        const savedImages = await Promise.all(
          nativeResult.images.map((image) =>
            saveMediaBuffer(
              image.buffer,
              image.mimeType,
              "tool-image-generation",
              undefined,
              filename || image.fileName,
            ),
          ),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Generated ${savedImages.length} image${savedImages.length === 1 ? "" : "s"} with ${nativeResult.provider}/${nativeResult.model}.`,
            },
          ],
          details: {
            provider: nativeResult.provider,
            model: nativeResult.model,
            prompt,
            grounded,
            count: savedImages.length,
            media: {
              mediaUrls: savedImages.map((image) => image.path),
            },
            paths: savedImages.map((image) => image.path),
            ...(imageInputs.length === 1
              ? { image: imageInputs[0] }
              : imageInputs.length > 1
                ? { images: imageInputs }
                : {}),
            ...(size ? { size } : {}),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
            attempts: nativeResult.attempts,
            ...(nativeResult.text ? { text: nativeResult.text } : {}),
          },
        };
      }

      const cfg = buildGeminiImageConfig(api.config, pluginConfig, model);
      const result = await api.runtime.imageGeneration.generate({
        cfg,
        prompt,
        count,
        size,
        aspectRatio,
        resolution,
        inputImages: inputImages.map((image) => ({
          buffer: image.buffer,
          mimeType: image.mimeType,
        })),
      });

      const savedImages = await Promise.all(
        result.images.map((image) =>
          saveMediaBuffer(
            image.buffer,
            image.mimeType,
            "tool-image-generation",
            undefined,
            filename || image.fileName,
          ),
        ),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Generated ${savedImages.length} image${savedImages.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
          },
        ],
        details: {
          provider: result.provider,
          model: result.model,
          prompt,
          count: savedImages.length,
          media: {
            mediaUrls: savedImages.map((image) => image.path),
          },
          paths: savedImages.map((image) => image.path),
          ...(imageInputs.length === 1
            ? { image: imageInputs[0] }
            : imageInputs.length > 1
              ? { images: imageInputs }
              : {}),
          ...(size ? { size } : {}),
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(resolution ? { resolution } : {}),
          attempts: result.attempts,
          metadata: result.metadata,
        },
      };
    },
  };
}
