import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNovelWriterTool } from "./novel-writer-tool.js";

describe("novel writer tool", () => {
  const runEmbeddedPiAgentMock = vi.fn();
  const originalLlmModel = process.env.LLM_MODEL;
  let workspaceDir: string;

  beforeEach(async () => {
    runEmbeddedPiAgentMock.mockReset();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-novel-writer-test-"));
    if (originalLlmModel === undefined) {
      delete process.env.LLM_MODEL;
    } else {
      process.env.LLM_MODEL = originalLlmModel;
    }
  });

  it("uses Gemini 3.1 Pro by default and disables tools", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "雨夜里，他第一次推开了旧书店的门。" }],
    });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-1", {
      prompt: "写一个都市奇幻小说开篇，主角在雨夜进入旧书店。",
      mode: "chapter",
      title: "雨幕之门",
      chapterTitle: "旧书店",
      chapterIndex: 1,
      openingChapter: true,
      hookStrength: "high",
      wordTarget: 1800,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        disableTools: true,
        prompt: expect.stringContaining("Strictly isolate POV knowledge"),
        streamParams: {
          maxTokens: undefined,
        },
      }),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "雨夜里，他第一次推开了旧书店的门。" }],
      details: {
        provider: "google",
        model: "gemini-3.1-pro-preview",
        language: "zh-CN",
        estimatedLength: 17,
        chapterTitle: "旧书店",
        savedPath: expect.stringContaining(workspaceDir),
      },
    });
    const savedPath = (result.details as { savedPath: string }).savedPath;
    expect(savedPath).toContain(path.join(workspaceDir, "雨幕之门"));
    expect(path.basename(savedPath)).toMatch(/^chapter-01_旧书店_/u);
    await expect(fs.readFile(savedPath, "utf8")).resolves.toContain(
      "雨夜里，他第一次推开了旧书店的门。",
    );
  });

  it("applies plugin config and includes existing text for continue mode", async () => {
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "站台尽头" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "她没有回头，只是把车票攥得更紧。" }],
      });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {
          model: "gemini-3.1-pro-preview",
          language: "en-US",
          thinking: "medium",
          maxTokens: 4096,
          timeoutMs: 90000,
        },
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    await tool.execute("call-2", {
      prompt: "Continue the train-station farewell scene with restrained emotion.",
      mode: "continue",
      existingText: "The platform was nearly empty when the last train arrived.",
      genre: "urban_female",
      style: "quiet, cinematic, emotionally restrained",
      continuityNotes:
        "Keep the heroine emotionally restrained and preserve the unresolved family conflict.",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "gemini-3.1-pro-preview",
        thinkLevel: "medium",
        timeoutMs: 90000,
        streamParams: {
          maxTokens: 4096,
        },
        prompt: expect.stringContaining("Genre profile: 都市女频."),
      }),
    );
  });

  it("rejects invalid thinking levels", async () => {
    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    await expect(
      tool.execute("call-3", {
        prompt: "写一个悬疑故事场景。",
        thinking: "turbo",
      }),
    ).rejects.toThrow("thinking must be one of");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("uses LLM_MODEL when no per-call or plugin model override is set", async () => {
    process.env.LLM_MODEL = "gemini-3.1-pro-preview";
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "Lantern Sway" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "The lantern swayed once, then went still." }],
      });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    await tool.execute("call-4", {
      prompt: "Write a suspenseful opening scene in English.",
      language: "en-US",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "gemini-3.1-pro-preview",
      }),
    );
  });

  it("adds genre metadata to the result details", async () => {
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "裂缝回声" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "冷寂的舱壁上映着她的影子，像一段被折叠过的时间。" }],
      });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-5", {
      prompt: "写一个硬科幻开场，女工程师在失压舱段独自维修。",
      genre: "scifi_hard",
      language: "zh-CN",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        genre: "scifi_hard",
        chapterTitle: "裂缝回声",
      }),
    );
  });

  it("supports save=false and custom fileName", async () => {
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "旧走廊" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "她推开门，风从旧走廊尽头吹来。" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "旧走廊" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "她推开门，风从旧走廊尽头吹来。" }],
      });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const unsaved = await tool.execute("call-6", {
      prompt: "写一个悬疑场景。",
      save: false,
    });
    expect(unsaved.details).not.toHaveProperty("savedPath");

    const saved = await tool.execute("call-7", {
      prompt: "写一个悬疑场景。",
      fileName: "chapter one draft",
    });
    const savedPath = (saved.details as { savedPath: string }).savedPath;
    expect(path.basename(savedPath)).toBe("chapter-one-draft.md");
    await expect(fs.readFile(savedPath, "utf8")).resolves.toContain("她推开门");
  });

  it("stores drafts under a title-based folder when title is present", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "霜降那天，城门外第一声鼓响得极慢。" }],
    });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-8", {
      prompt: "写一个古风开篇。",
      title: "霜城夜鼓",
      chapterIndex: 1,
      chapterTitle: "鼓声",
    });

    const savedPath = (result.details as { savedPath: string }).savedPath;
    expect(savedPath).toContain(path.join(workspaceDir, "霜城夜鼓"));
    expect(path.basename(savedPath)).toMatch(/^chapter-01_鼓声_/u);
  });

  it("supports setup mode and saves a persistent book profile", async () => {
    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-9", {
      mode: "setup",
      title: "长夜轨道",
      prompt: "近未来轨道城市里，一个维修员卷入权力事故。",
      genre: "scifi_hard",
      targetUsers: "喜欢硬科幻和悬疑推进的男性与泛科幻读者",
      marketPosition: "中篇付费连载，强调技术感和悬疑钩子",
      sellingPoints: "失压舱维修、轨道灾难、工程细节、权力阴谋",
      coreTheme: "人在系统故障中的责任与选择",
      worldSetup: "轨道电梯时代，城市依赖分层轨道站运转。",
      characterSetup: "主角是年轻女工程师，擅长舱段抢修但政治经验不足。",
    });

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: "text", text: "Book setup saved for 长夜轨道." }]);
    const profilePath = path.join(workspaceDir, "长夜轨道", "_book.json");
    const markdownPath = path.join(workspaceDir, "长夜轨道", "_book.md");
    const profile = JSON.parse(await fs.readFile(profilePath, "utf8")) as Record<string, string>;
    expect(profile.targetUsers).toContain("硬科幻");
    await expect(fs.readFile(markdownPath, "utf8")).resolves.toContain("## Book Profile");
  });

  it("injects stored book setup into later chapter prompts", async () => {
    await fs.mkdir(path.join(workspaceDir, "长夜轨道"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "长夜轨道", "_book.json"),
      `${JSON.stringify(
        {
          title: "长夜轨道",
          genre: "scifi_hard",
          targetUsers: "科幻读者",
          marketPosition: "工程灾难悬疑",
          sellingPoints: "工程细节",
          coreTheme: "责任",
          premise: "轨道城维修员卷入事故。",
          worldSetup: "轨道城市。",
          characterSetup: "维修员主角。",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "她把扳手扣回腰间，抬头看见站环外侧的裂光。" }],
    });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    await tool.execute("call-10", {
      title: "长夜轨道",
      chapterIndex: 1,
      chapterTitle: "裂光",
      prompt: "写第一章开场。",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Stored book setup:"),
      }),
    );
  });

  it("injects recent saved chapters into later chapter prompts", async () => {
    const bookDir = path.join(workspaceDir, "长夜轨道");
    await fs.mkdir(bookDir, { recursive: true });
    await fs.writeFile(
      path.join(bookDir, "_book.json"),
      `${JSON.stringify(
        {
          title: "长夜轨道",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(bookDir, "chapter-01_裂光_2026-03-25T00-00-00Z.md"),
      "第一章内容：她在站环外侧看见裂光。",
      "utf8",
    );
    await fs.writeFile(
      path.join(bookDir, "chapter-02_失压_2026-03-25T00-10-00Z.md"),
      "第二章内容：舱段开始失压，警报响起。",
      "utf8",
    );
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "第三章内容：她决定独自进入维修井。" }],
    });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    await tool.execute("call-11", {
      title: "长夜轨道",
      chapterIndex: 3,
      chapterTitle: "维修井",
      prompt: "写第三章开场。",
      contextChapters: 2,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Recent chapter context:"),
      }),
    );
    expect(runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt).toContain("chapter-01_裂光");
    expect(runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt).toContain("chapter-02_失压");
  });

  it("allows disabling recent chapter context", async () => {
    const bookDir = path.join(workspaceDir, "霜城夜鼓");
    await fs.mkdir(bookDir, { recursive: true });
    await fs.writeFile(
      path.join(bookDir, "_book.json"),
      `${JSON.stringify(
        {
          title: "霜城夜鼓",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(bookDir, "chapter-01_鼓声.md"), "旧章节。", "utf8");
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "新章节。" }],
    });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    await tool.execute("call-12", {
      title: "霜城夜鼓",
      chapterIndex: 2,
      prompt: "写第二章。",
      contextChapters: 0,
    });

    expect(runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt).not.toContain(
      "Recent chapter context:",
    );
  });

  it("auto-increments chapterIndex from existing chapter files", async () => {
    const bookDir = path.join(workspaceDir, "长夜轨道");
    await fs.mkdir(bookDir, { recursive: true });
    await fs.writeFile(
      path.join(bookDir, "_book.json"),
      `${JSON.stringify(
        {
          title: "长夜轨道",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(bookDir, "chapter-01_裂光.md"), "第一章。", "utf8");
    await fs.writeFile(path.join(bookDir, "chapter-02_失压.md"), "第二章。", "utf8");
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "第三章。" }],
    });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-13", {
      title: "长夜轨道",
      chapterTitle: "维修井",
      prompt: "写下一章。",
      contextChapters: 1,
    });

    const savedPath = (result.details as { savedPath: string }).savedPath;
    expect(path.basename(savedPath)).toMatch(/^chapter-03_维修井_/u);
    expect(runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt).toContain("Chapter number: 3");
  });

  it("leaves chapterIndex unset when no prior chapters exist", async () => {
    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: JSON.stringify({
              targetUsers: "悬疑读者",
              marketPosition: "中篇悬疑连载",
              sellingPoints: "雨夜、异象、陌生来客",
              coreTheme: "未知闯入日常秩序",
              premise: "一场雨夜开启了主角无法回头的故事。",
              worldSetup: "现代都市，夹杂超自然异象。",
              characterSetup: "普通人主角，对异象毫无准备。",
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "第一场雨" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "开篇正文。" }],
      });

    await tool.execute("call-14", {
      title: "新书计划",
      prompt: "写一个开篇。",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(3);
    expect(runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt).not.toContain("Chapter number:");
  });

  it("auto-generates chapterTitle when omitted", async () => {
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: JSON.stringify({
              targetUsers: "硬科幻读者",
              marketPosition: "工程灾难悬疑连载",
              sellingPoints: "轨道城、失压、维修危机",
              coreTheme: "责任与代价",
              premise: "轨道城维修员在事故中发现更大的危机。",
              worldSetup: "轨道电梯时代的分层站环城市。",
              characterSetup: "年轻女工程师，擅长抢修。",
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "裂光之下" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "她扶着扶梯外缘，看见轨道城在真空里微微震颤。" }],
      });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-15", {
      title: "长夜轨道",
      prompt: "写下一章。",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(3);
    expect(runEmbeddedPiAgentMock.mock.calls[1]?.[0]?.prompt).toContain(
      "You generate concise fiction chapter titles.",
    );
    expect(runEmbeddedPiAgentMock.mock.calls[2]?.[0]?.prompt).toContain("Chapter title: 裂光之下");
    expect(result.details).toEqual(
      expect.objectContaining({
        chapterTitle: "裂光之下",
      }),
    );
  });

  it("auto-generates and saves initial book setup before drafting a new novel", async () => {
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: JSON.stringify({
              targetUsers: "喜欢硬科幻与悬疑推进的读者",
              marketPosition: "长篇连载，主打工程灾难与阴谋悬念",
              sellingPoints: "失压抢修、轨道危机、工程细节、权力事故",
              coreTheme: "责任与代价",
              premise: "轨道城维修员在事故中发现更大的隐患。",
              worldSetup: "轨道电梯时代，城市依靠分层轨道站运行。",
              characterSetup: "年轻女工程师，擅长抢修，政治经验不足。",
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "裂隙起点" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "警报响起时，她刚把安全扣锁进扶梯轨道。" }],
      });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-16", {
      title: "长夜轨道",
      genre: "scifi_hard",
      prompt: "写一本新小说的第一章开头。",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(3);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt).toContain(
      "You create initial commercial-fiction book setups.",
    );
    const profile = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "长夜轨道", "_book.json"), "utf8"),
    ) as Record<string, string>;
    expect(profile.targetUsers).toContain("硬科幻");
    expect(profile.marketPosition).toContain("工程灾难");
    expect(result.details).toEqual(
      expect.objectContaining({
        chapterTitle: "裂隙起点",
      }),
    );
  });

  it("reuses existing book setup without regenerating it", async () => {
    const bookDir = path.join(workspaceDir, "长夜轨道");
    await fs.mkdir(bookDir, { recursive: true });
    await fs.writeFile(
      path.join(bookDir, "_book.json"),
      `${JSON.stringify(
        {
          title: "长夜轨道",
          targetUsers: "科幻读者",
          marketPosition: "工程悬疑",
          sellingPoints: "工程细节",
          coreTheme: "责任",
          premise: "轨道城维修员卷入事故。",
          worldSetup: "轨道城市。",
          characterSetup: "维修员主角。",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "裂光再起" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "她听见站环深处的第二次金属回响。" }],
      });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    await tool.execute("call-17", {
      title: "长夜轨道",
      prompt: "写下一章。",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt).toContain(
      "You generate concise fiction chapter titles.",
    );
  });

  it("returns an editorial report in review mode", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [
        {
          text: [
            "## Major Issues",
            "- 开篇张力不足，前三段信息在重复同一情绪。",
            "",
            "## Revision Plan",
            "- 直接从冲突发生的时刻切入。",
          ].join("\n"),
        },
      ],
    });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-18", {
      mode: "review",
      title: "长夜轨道",
      prompt: "审稿这章，重点看钩子、节奏和 AI 味。",
      existingText: "她站在窗口前想了很久，然后回忆起很多往事。",
      fileName: "chapter-01-review",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("You are a senior fiction editor."),
      }),
    );
    expect(runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt).toContain(
      "Editorial review protocol:",
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("## Major Issues"),
      },
    ]);
    const savedPath = (result.details as { savedPath: string }).savedPath;
    expect(path.basename(savedPath)).toBe("chapter-01-review.md");
  });

  it("reviews stored book setup when no existingText is provided", async () => {
    const bookDir = path.join(workspaceDir, "长夜轨道");
    await fs.mkdir(bookDir, { recursive: true });
    await fs.writeFile(
      path.join(bookDir, "_book.json"),
      `${JSON.stringify(
        {
          title: "长夜轨道",
          targetUsers: "科幻读者",
          marketPosition: "工程悬疑",
          sellingPoints: "工程细节",
          coreTheme: "责任",
          premise: "轨道城维修员卷入事故。",
          worldSetup: "轨道城市。",
          characterSetup: "维修员主角。",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "## Major Issues\n- 目标用户过宽，差异化不够。" }],
    });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-19", {
      mode: "review",
      title: "长夜轨道",
      prompt: "审阅这本书的基础设定。",
    });

    expect(runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt).toContain(
      "reviewing a book-level setup",
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        reviewTarget: "book_setup",
      }),
    );
  });

  it("requires existingText for review and revise modes", async () => {
    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    await expect(
      tool.execute("call-19", {
        mode: "review",
        prompt: "帮我审稿。",
      }),
    ).rejects.toThrow(
      "existingText is required for review and revise modes unless a book setup is available",
    );

    await expect(
      tool.execute("call-20", {
        mode: "revise",
        prompt: "帮我重写这一章。",
      }),
    ).rejects.toThrow(
      "existingText is required for review and revise modes unless a book setup is available",
    );
  });

  it("revises and saves stored book setup when no existingText is provided", async () => {
    const bookDir = path.join(workspaceDir, "长夜轨道");
    await fs.mkdir(bookDir, { recursive: true });
    await fs.writeFile(
      path.join(bookDir, "_book.json"),
      `${JSON.stringify(
        {
          title: "长夜轨道",
          targetUsers: "泛科幻读者",
          marketPosition: "科幻悬疑",
          sellingPoints: "轨道城",
          coreTheme: "责任",
          premise: "维修员卷入事故。",
          worldSetup: "轨道城市。",
          characterSetup: "年轻维修员。",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            targetUsers: "喜欢硬科幻与工程灾难的读者",
            marketPosition: "工程灾难悬疑长篇",
            sellingPoints: "失压抢修、轨道危机、工程细节",
            coreTheme: "责任与代价",
            premise: "轨道城维修员在事故中发现更大的阴谋。",
            worldSetup: "轨道电梯时代的分层站环城市。",
            characterSetup: "年轻女工程师，擅长抢修，政治经验不足。",
          }),
        },
      ],
    });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-20a", {
      mode: "revise",
      title: "长夜轨道",
      prompt: "把这本书的目标用户、定位和卖点改得更商业化。",
    });

    const profile = JSON.parse(
      await fs.readFile(path.join(bookDir, "_book.json"), "utf8"),
    ) as Record<string, string>;
    expect(profile.targetUsers).toContain("硬科幻");
    expect(profile.marketPosition).toContain("工程灾难");
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("## Book Profile"),
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        reviewTarget: "book_setup",
      }),
    );
  });

  it("revises an existing draft with revision protocol", async () => {
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: JSON.stringify({
              targetUsers: "硬科幻读者",
              marketPosition: "工程悬疑连载",
              sellingPoints: "失压抢修、轨道故障",
              coreTheme: "责任",
              premise: "维修员卷入轨道事故。",
              worldSetup: "轨道城。",
              characterSetup: "年轻工程师。",
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "失压边缘" }],
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "警报响起时，她已经把手套扣紧，没有再给自己后退的时间。" }],
      });

    const tool = createNovelWriterTool(
      {
        config: {},
        pluginConfig: {},
        runtime: {
          agent: {
            runEmbeddedPiAgent: runEmbeddedPiAgentMock,
          },
        },
      } as never,
      { workspaceDir } as never,
    );

    const result = await tool.execute("call-21", {
      mode: "revise",
      title: "长夜轨道",
      prompt: "把这一章改得更有压迫感，减少解释性句子。",
      existingText: "警报响了。她很紧张，也觉得事情很严重，所以决定快点去修。",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(3);
    expect(runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt).toContain("Revision protocol:");
    expect(runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt).toContain("Draft to revise:");
    expect(result.details).toEqual(
      expect.objectContaining({
        chapterTitle: "失压边缘",
      }),
    );
    const savedPath = (result.details as { savedPath: string }).savedPath;
    expect(path.basename(savedPath)).toMatch(/^失压边缘_/u);
  });
});
