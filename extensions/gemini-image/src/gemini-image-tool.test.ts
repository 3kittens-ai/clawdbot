import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiImageTool } from "./gemini-image-tool.js";

const saveMediaBufferMock = vi.fn();
const loadWebMediaMock = vi.fn();
const postJsonRequestMock = vi.fn();
const assertOkOrThrowHttpErrorMock = vi.fn();

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBufferMock(...args),
}));

vi.mock("openclaw/plugin-sdk/media-understanding", () => ({
  postJsonRequest: (...args: unknown[]) => postJsonRequestMock(...args),
  assertOkOrThrowHttpError: (...args: unknown[]) => assertOkOrThrowHttpErrorMock(...args),
  normalizeBaseUrl: (raw: string | undefined, fallback: string) =>
    (raw?.trim() || fallback).replace(/\/+$/, ""),
}));

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
}));

describe("gemini image tool", () => {
  beforeEach(() => {
    saveMediaBufferMock.mockReset();
    loadWebMediaMock.mockReset();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockResolvedValue(undefined);
  });

  it("generates images with the Gemini defaults", async () => {
    const generateImageMock = vi.fn().mockResolvedValue({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("image-1"),
          mimeType: "image/png",
          fileName: "generated.png",
        },
      ],
    });
    saveMediaBufferMock.mockResolvedValue({ path: "MEDIA:/tmp/generated.png" });

    const tool = createGeminiImageTool({
      config: {},
      pluginConfig: {},
      runtime: {
        imageGeneration: {
          generate: generateImageMock,
        },
        agent: {},
      },
    } as never);

    const result = await tool.execute("call-1", {
      prompt: "画一张极简海报",
      aspectRatio: "3:4",
      resolution: "2K",
    });

    expect(generateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              imageGenerationModel: {
                primary: "google/gemini-3.1-flash-image-preview",
                fallbacks: ["google/gemini-3-pro-image-preview"],
              },
            }),
          }),
        }),
        prompt: "画一张极简海报",
        aspectRatio: "3:4",
        resolution: "2K",
        inputImages: [],
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        paths: ["MEDIA:/tmp/generated.png"],
      }),
    );
  });

  it("loads reference images for Gemini edit requests", async () => {
    loadWebMediaMock.mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("ref"),
      contentType: "image/png",
    });
    const generateImageMock = vi.fn().mockResolvedValue({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      attempts: [{ provider: "google", model: "gemini-3.1-flash-image-preview", error: "empty" }],
      images: [
        {
          buffer: Buffer.from("edited"),
          mimeType: "image/png",
          fileName: "edited.png",
        },
      ],
    });
    saveMediaBufferMock.mockResolvedValue({ path: "MEDIA:/tmp/edited.png" });

    const tool = createGeminiImageTool({
      config: {},
      pluginConfig: { model: "gemini-3.1-flash-image-preview" },
      runtime: {
        imageGeneration: {
          generate: generateImageMock,
        },
        agent: {},
      },
    } as never);

    const result = await tool.execute("call-2", {
      prompt: "保留主体，改成杂志封面风格",
      image: "/tmp/input.png",
      count: 1,
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("/tmp/input.png");
    expect(generateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImages: [{ buffer: Buffer.from("ref"), mimeType: "image/png" }],
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        image: "/tmp/input.png",
        paths: ["MEDIA:/tmp/edited.png"],
      }),
    );
  });

  it("describes images through the native Gemini request path", async () => {
    loadWebMediaMock.mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("describe-ref"),
      contentType: "image/png",
    });
    postJsonRequestMock.mockResolvedValue({
      response: {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: "这是一张产品海报，主体居中，背景干净。" }],
              },
            },
          ],
        }),
      },
      release: async () => {},
    });

    const tool = createGeminiImageTool({
      config: {},
      pluginConfig: {},
      runtime: {
        modelAuth: {
          resolveApiKeyForProvider: vi.fn().mockResolvedValue({ apiKey: "test-key" }),
        },
        imageGeneration: {
          generate: vi.fn(),
        },
        agent: {},
      },
    } as never);

    const result = await tool.execute("call-3", {
      action: "describe",
      prompt: "描述这张图片的画面和文案布局",
      image: "/tmp/describe.png",
      maxTokens: 600,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          contents: [
            expect.objectContaining({
              parts: expect.arrayContaining([
                expect.objectContaining({
                  inlineData: expect.objectContaining({
                    mimeType: "image/png",
                  }),
                }),
                { text: "描述这张图片的画面和文案布局" },
              ]),
            }),
          ],
          generationConfig: {
            maxOutputTokens: 600,
          },
        }),
      }),
    );
    expect(result.content).toEqual([
      { type: "text", text: "这是一张产品海报，主体居中，背景干净。" },
    ]);
  });

  it("uses native Gemini grounded generation when grounded is enabled", async () => {
    postJsonRequestMock
      .mockResolvedValueOnce({
        response: {
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: "first attempt text only" }],
                },
              },
            ],
          }),
        },
        release: async () => {},
      })
      .mockResolvedValueOnce({
        response: {
          ok: true,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    { text: "grounded result" },
                    {
                      inlineData: {
                        mimeType: "image/png",
                        data: Buffer.from("img").toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        },
        release: async () => {},
      });
    saveMediaBufferMock.mockResolvedValue({ path: "MEDIA:/tmp/grounded.png" });

    const tool = createGeminiImageTool({
      config: {},
      pluginConfig: {},
      runtime: {
        modelAuth: {
          resolveApiKeyForProvider: vi.fn().mockResolvedValue({ apiKey: "test-key" }),
        },
        imageGeneration: {
          generate: vi.fn(),
        },
        agent: {},
      },
    } as never);

    const result = await tool.execute("call-4", {
      prompt: "生成一张基于搜索信息的新品海报",
      grounded: true,
      size: "1024x1536",
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(2);
    expect(postJsonRequestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: expect.objectContaining({
          tools: [{ googleSearch: {} }],
          generationConfig: expect.objectContaining({
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: expect.objectContaining({
              aspectRatio: "2:3",
            }),
          }),
        }),
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        grounded: true,
        paths: ["MEDIA:/tmp/grounded.png"],
      }),
    );
  });
});
