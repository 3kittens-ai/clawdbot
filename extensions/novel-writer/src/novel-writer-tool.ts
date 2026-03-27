import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  ToolInputError,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";

const DEFAULT_PROVIDER = "google";
const DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const DEFAULT_LANGUAGE = "zh-CN";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SAVE = true;
const DEFAULT_CONTEXT_CHAPTERS = 3;
const MAX_PROMPT_CHARS = 32_000;
const MAX_EXISTING_TEXT_CHARS = 120_000;
const MAX_CONTEXT_CHARS = 24_000;
const VALID_THINKING_LEVELS = "off, minimal, low, medium, high, adaptive, xhigh";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "adaptive", "xhigh"]);

type NovelWriterPluginConfig = {
  model?: string;
  language?: string;
  genre?: string;
  thinking?: string;
  maxTokens?: number;
  timeoutMs?: number;
};

type GenreProfile = {
  label: string;
  role: string;
  aesthetics: string[];
  taboos: string[];
};

type BookProfile = {
  title: string;
  language?: string;
  genre?: string;
  audience?: string;
  targetUsers?: string;
  marketPosition?: string;
  sellingPoints?: string;
  coreTheme?: string;
  premise?: string;
  worldSetup?: string;
  characterSetup?: string;
  style?: string;
  continuityNotes?: string;
  createdAt: string;
  updatedAt: string;
};

type BookProfilePatch = Pick<
  BookProfile,
  | "targetUsers"
  | "marketPosition"
  | "sellingPoints"
  | "coreTheme"
  | "premise"
  | "worldSetup"
  | "characterSetup"
>;

type NovelWriterMode =
  | "setup"
  | "outline"
  | "chapter"
  | "scene"
  | "continue"
  | "rewrite"
  | "review"
  | "revise";

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

const GENRE_PROFILES: Record<string, GenreProfile> = {
  urban_female: {
    label: "都市女频",
    role: "优先考虑女性读者的代入感、情绪价值、人物张力和现代都市关系博弈。",
    aesthetics: [
      "每章提供明确情绪价值，例如甜、虐、爽、燃之一。",
      "强化微表情、眼神、停顿、社交场域中的潜台词。",
      "允许打脸、逆袭、阶层对照，但关键问题仍应由女主主动解决。",
    ],
    taboos: [
      "不要把女主写成失去判断力的恋爱脑。",
      "不要让男主成为无条件救场的救世主。",
      "不要把反派写成一眼就能看穿的纸片工具人。",
    ],
  },
  scifi_hard: {
    label: "硬科幻",
    role: "优先考虑技术逻辑、物理约束、尺度感和理性叙事张力。",
    aesthetics: [
      "科技或超常机制必须有成本、限制和副作用。",
      "强调宇宙尺度、观测细节、系统故障、伦理困境。",
      "情感描写要克制，用数据、观测和行动替代空泛抒情。",
    ],
    taboos: [
      "不要把科技写成没有代价的魔法。",
      "不要让爱与勇气直接违背物理定律。",
      "不要用无解释的超光速、瞬移或万能黑箱技术推进剧情。",
    ],
  },
  ancient_romance: {
    label: "古风女频",
    role: "优先考虑古风礼制美学、权谋智斗、情感纠葛和女性生存智慧。",
    aesthetics: [
      "服饰、礼仪、称谓、尊卑秩序应成为人物博弈的一部分。",
      "对话表面恭顺，潜台词里要有试探、压制、交易或反击。",
      "身份反转、宅斗宫斗、证据回收要有铺垫和后手。",
    ],
    taboos: [
      "不要让角色直接使用现代思维和现代口吻。",
      "不要把女主写成只有善良没有底线的圣母。",
      "不要让男主包办关键翻盘时刻。",
    ],
  },
};

const NovelWriterToolSchema = Type.Object(
  {
    prompt: Type.String({
      description: "Core fiction-writing request, premise, or scene instruction.",
    }),
    mode: Type.Optional(
      Type.String({
        description:
          'Optional writing mode: "setup", "outline", "chapter", "scene", "continue", "rewrite", "review", or "revise".',
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: "Optional novel or chapter title.",
      }),
    ),
    chapterTitle: Type.Optional(
      Type.String({
        description: "Optional chapter title to anchor the draft.",
      }),
    ),
    chapterIndex: Type.Optional(
      Type.Number({
        description: "Optional chapter number.",
        minimum: 1,
      }),
    ),
    style: Type.Optional(
      Type.String({
        description: "Optional prose style, tone, or authorial direction.",
      }),
    ),
    audience: Type.Optional(
      Type.String({
        description: "Optional target audience, for example YA, adult, or web novel readers.",
      }),
    ),
    targetUsers: Type.Optional(
      Type.String({
        description: "Optional target user description for the whole book.",
      }),
    ),
    marketPosition: Type.Optional(
      Type.String({
        description: "Optional market positioning, hook, or shelf pitch.",
      }),
    ),
    sellingPoints: Type.Optional(
      Type.String({
        description: "Optional core selling points, emotional payoff, or genre hooks.",
      }),
    ),
    coreTheme: Type.Optional(
      Type.String({
        description: "Optional core theme, proposition, or philosophical throughline.",
      }),
    ),
    worldSetup: Type.Optional(
      Type.String({
        description: "Optional worldbuilding or setting baseline to persist for the book.",
      }),
    ),
    characterSetup: Type.Optional(
      Type.String({
        description: "Optional core cast setup to persist for the book.",
      }),
    ),
    genre: Type.Optional(
      Type.String({
        description: 'Optional genre profile: "urban_female", "scifi_hard", or "ancient_romance".',
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: "Optional output language, for example zh-CN or en-US.",
      }),
    ),
    wordTarget: Type.Optional(
      Type.Number({
        description: "Optional approximate target length.",
        minimum: 100,
      }),
    ),
    openingChapter: Type.Optional(
      Type.Boolean({
        description: "Enable stronger opening-chapter hook and conflict rules.",
      }),
    ),
    hookStrength: Type.Optional(
      Type.String({
        description: 'Optional hook intensity: "low", "medium", or "high".',
      }),
    ),
    continuityNotes: Type.Optional(
      Type.String({
        description: "Optional continuity, canon, or prior-chapter notes that must be preserved.",
      }),
    ),
    existingText: Type.Optional(
      Type.String({
        description: "Optional existing draft for continue or rewrite tasks.",
      }),
    ),
    thinking: Type.Optional(
      Type.String({
        description: `Optional thinking level: ${VALID_THINKING_LEVELS}.`,
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Optional Gemini model override. Accepts provider/model or a bare Gemini model id.",
      }),
    ),
    maxTokens: Type.Optional(
      Type.Number({
        description: "Optional max output tokens.",
        minimum: 1,
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "Optional timeout in milliseconds.",
        minimum: 1,
      }),
    ),
    save: Type.Optional(
      Type.Boolean({
        description: "Whether to save the generated draft into the current agent workspace.",
      }),
    ),
    fileName: Type.Optional(
      Type.String({
        description: "Optional output filename, for example chapter-01.md.",
      }),
    ),
    contextChapters: Type.Optional(
      Type.Number({
        description: "Optional number of previous saved chapters to inject as context.",
        minimum: 0,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

function normalizeModelRef(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.includes("/") ? trimmed : `${DEFAULT_PROVIDER}/${trimmed}`;
}

function normalizeMode(raw: string | undefined): string {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return "chapter";
  }
  if (
    trimmed === "setup" ||
    trimmed === "outline" ||
    trimmed === "chapter" ||
    trimmed === "scene" ||
    trimmed === "continue" ||
    trimmed === "rewrite" ||
    trimmed === "review" ||
    trimmed === "revise"
  ) {
    return trimmed;
  }
  throw new ToolInputError(
    'mode must be "setup", "outline", "chapter", "scene", "continue", "rewrite", "review", or "revise"',
  );
}

function normalizeLanguage(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  return trimmed || fallback;
}

function normalizePositiveInteger(
  rawParams: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readNumberParam(rawParams, key, { integer: true });
  if (value === undefined) {
    return undefined;
  }
  if (value <= 0) {
    throw new ToolInputError(`${key} must be greater than 0`);
  }
  return value;
}

function normalizeNonNegativeInteger(
  rawParams: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readNumberParam(rawParams, key, { integer: true });
  if (value === undefined) {
    return undefined;
  }
  if (value < 0) {
    throw new ToolInputError(`${key} must be 0 or greater`);
  }
  return value;
}

function normalizeThinking(raw: string | undefined): ThinkLevel | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (!THINKING_LEVELS.has(normalized)) {
    throw new ToolInputError(`thinking must be one of ${VALID_THINKING_LEVELS}`);
  }
  return normalized as ThinkLevel;
}

function normalizeGenre(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed in GENRE_PROFILES) {
    return trimmed;
  }
  throw new ToolInputError('genre must be "urban_female", "scifi_hard", or "ancient_romance"');
}

function normalizeHookStrength(raw: string | undefined): "low" | "medium" | "high" {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return "medium";
  }
  if (trimmed === "low" || trimmed === "medium" || trimmed === "high") {
    return trimmed;
  }
  throw new ToolInputError('hookStrength must be "low", "medium", or "high"');
}

function sanitizeFileBaseName(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
}

function buildDefaultFileName(params: {
  title?: string;
  chapterTitle?: string;
  mode: NovelWriterMode;
  chapterIndex?: number;
}): string {
  const parts: string[] = [];
  if (
    params.chapterIndex &&
    (params.mode === "chapter" ||
      params.mode === "scene" ||
      params.mode === "continue" ||
      params.mode === "rewrite" ||
      params.mode === "revise")
  ) {
    parts.push(`chapter-${String(params.chapterIndex).padStart(2, "0")}`);
  }
  const preferredLabel = params.chapterTitle?.trim() || params.title?.trim() || params.mode;
  const slug = sanitizeFileBaseName(preferredLabel) || params.mode;
  const timestamp = new Date()
    .toISOString()
    .replace(/[:]/gu, "-")
    .replace(/\.\d{3}Z$/u, "Z");
  parts.push(slug, timestamp);
  return `${parts.join("_")}.md`;
}

function resolveOutputFileName(
  rawFileName: string | undefined,
  params: {
    title?: string;
    chapterTitle?: string;
    mode: NovelWriterMode;
    chapterIndex?: number;
  },
): string {
  const trimmed = rawFileName?.trim();
  if (!trimmed) {
    return buildDefaultFileName(params);
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new ToolInputError("fileName must be a file name only, not a path");
  }
  const sanitized = sanitizeFileBaseName(trimmed.replace(/\.[^.]+$/u, ""));
  if (!sanitized) {
    throw new ToolInputError("fileName is invalid after sanitization");
  }
  return trimmed.endsWith(".md") ? `${sanitized}.md` : `${sanitized}.md`;
}

function resolveOutputDir(workspaceDir: string, title: string | undefined): string {
  const trimmed = title?.trim();
  if (!trimmed) {
    return workspaceDir;
  }
  const slug = sanitizeFileBaseName(trimmed);
  if (!slug) {
    return workspaceDir;
  }
  return path.join(workspaceDir, slug);
}

function buildBookProfileMarkdown(profile: BookProfile): string {
  const lines = [
    `# ${profile.title}`,
    "",
    "## Book Profile",
    `- Language: ${profile.language || ""}`,
    `- Genre: ${profile.genre || ""}`,
    `- Audience: ${profile.audience || ""}`,
    `- Target Users: ${profile.targetUsers || ""}`,
    `- Market Position: ${profile.marketPosition || ""}`,
    `- Selling Points: ${profile.sellingPoints || ""}`,
    `- Core Theme: ${profile.coreTheme || ""}`,
    `- Style: ${profile.style || ""}`,
    `- Created At: ${profile.createdAt}`,
    `- Updated At: ${profile.updatedAt}`,
    "",
    "## Premise",
    profile.premise || "",
    "",
    "## World Setup",
    profile.worldSetup || "",
    "",
    "## Character Setup",
    profile.characterSetup || "",
    "",
    "## Continuity Notes",
    profile.continuityNotes || "",
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

function hasEditableBookProfileContent(profile: BookProfile | null | undefined): boolean {
  if (!profile) {
    return false;
  }
  return Boolean(
    profile.targetUsers?.trim() ||
    profile.marketPosition?.trim() ||
    profile.sellingPoints?.trim() ||
    profile.coreTheme?.trim() ||
    profile.premise?.trim() ||
    profile.worldSetup?.trim() ||
    profile.characterSetup?.trim(),
  );
}

function buildBookProfileSubject(profile: BookProfile): string {
  return [
    `Title: ${profile.title}`,
    `Genre: ${profile.genre || ""}`,
    `Audience: ${profile.audience || ""}`,
    `Target Users: ${profile.targetUsers || ""}`,
    `Market Position: ${profile.marketPosition || ""}`,
    `Selling Points: ${profile.sellingPoints || ""}`,
    `Core Theme: ${profile.coreTheme || ""}`,
    `Premise: ${profile.premise || ""}`,
    `World Setup: ${profile.worldSetup || ""}`,
    `Character Setup: ${profile.characterSetup || ""}`,
    `Style: ${profile.style || ""}`,
    `Continuity Notes: ${profile.continuityNotes || ""}`,
  ].join("\n");
}

async function loadBookProfile(outputDir: string): Promise<BookProfile | null> {
  try {
    const raw = await fs.readFile(path.join(outputDir, "_book.json"), "utf8");
    return JSON.parse(raw) as BookProfile;
  } catch {
    return null;
  }
}

async function saveBookProfile(outputDir: string, profile: BookProfile): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "_book.json"),
    `${JSON.stringify(profile, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(outputDir, "_book.md"), buildBookProfileMarkdown(profile), "utf8");
}

async function loadRecentChapterContext(
  outputDir: string,
  currentFileName: string,
  maxChapters: number,
): Promise<string[]> {
  if (maxChapters <= 0) {
    return [];
  }
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return [];
  }
  const chapterFiles = entries
    .filter((entry) => entry.endsWith(".md") && !entry.startsWith("_") && entry !== currentFileName)
    .sort((left, right) => left.localeCompare(right))
    .slice(-maxChapters);
  const loaded = await Promise.all(
    chapterFiles.map(async (fileName) => {
      try {
        const text = await fs.readFile(path.join(outputDir, fileName), "utf8");
        return {
          fileName,
          text: text.trim().slice(0, MAX_CONTEXT_CHARS),
        };
      } catch {
        return null;
      }
    }),
  );
  return loaded
    .filter((item): item is { fileName: string; text: string } => Boolean(item?.text))
    .map((item) => `[[${item.fileName}]]\n${item.text}`);
}

async function resolveNextChapterIndex(
  outputDir: string,
  explicitChapterIndex: number | undefined,
): Promise<number | undefined> {
  if (explicitChapterIndex !== undefined) {
    return explicitChapterIndex;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return undefined;
  }
  let maxIndex = 0;
  for (const entry of entries) {
    const match = entry.match(/^chapter-(\d{2,})_/u);
    if (!match) {
      continue;
    }
    const value = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(value) && value > maxIndex) {
      maxIndex = value;
    }
  }
  return maxIndex > 0 ? maxIndex + 1 : undefined;
}

function normalizeGeneratedChapterTitle(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^["'“”‘’《》【】\[\]\s]+/u, "")
    .replace(/["'“”‘’《》【】\[\]\s]+$/u, "")
    .split(/\r?\n/u)[0]
    ?.trim()
    .slice(0, 40);
}

function shouldAutoGenerateChapterTitle(
  mode: NovelWriterMode,
  chapterTitle: string | undefined,
): boolean {
  if (chapterTitle?.trim()) {
    return false;
  }
  return (
    mode === "chapter" ||
    mode === "scene" ||
    mode === "continue" ||
    mode === "rewrite" ||
    mode === "revise"
  );
}

function buildChapterTitlePrompt(params: {
  title?: string;
  chapterIndex?: number;
  prompt: string;
  language: string;
  genre?: string;
  bookProfile?: BookProfile | null;
  recentChapters?: string[];
}): string {
  const lines = [
    "You generate concise fiction chapter titles.",
    `Write in ${params.language}.`,
    "Return only the chapter title itself.",
    "No quotes, no markdown, no numbering, no explanation.",
    "Prefer 2 to 8 words for English, or 2 to 12 characters for Chinese when possible.",
    "The title should be vivid, readable, and fit commercial fiction.",
  ];
  if (params.title?.trim()) {
    lines.push(`Novel title: ${params.title.trim()}`);
  }
  if (params.chapterIndex) {
    lines.push(`Chapter number: ${params.chapterIndex}`);
  }
  if (params.genre) {
    lines.push(`Genre: ${params.genre}`);
  }
  if (params.bookProfile) {
    lines.push(
      `Premise: ${params.bookProfile.premise || ""}`,
      `Selling points: ${params.bookProfile.sellingPoints || ""}`,
      `Core theme: ${params.bookProfile.coreTheme || ""}`,
    );
  }
  if ((params.recentChapters?.length ?? 0) > 0) {
    lines.push("Recent chapter context:", ...(params.recentChapters ?? []));
  }
  lines.push("Upcoming chapter request:", params.prompt.trim());
  return lines.join("\n");
}

function buildAutoSetupPrompt(params: {
  title: string;
  prompt: string;
  language: string;
  genre?: string;
  audience?: string;
  style?: string;
  continuityNotes?: string;
}): string {
  const lines = [
    "You create initial commercial-fiction book setups.",
    `Write in ${params.language}.`,
    "Return one JSON object only. No markdown fences, no commentary.",
    "Required JSON keys: targetUsers, marketPosition, sellingPoints, coreTheme, premise, worldSetup, characterSetup.",
    "Each value must be a concise string.",
    "Make the setup commercially usable, specific, and aligned with the requested story.",
  ];
  lines.push(`Novel title: ${params.title}`);
  if (params.genre) {
    lines.push(`Genre: ${params.genre}`);
  }
  if (params.audience?.trim()) {
    lines.push(`Audience hint: ${params.audience.trim()}`);
  }
  if (params.style?.trim()) {
    lines.push(`Style hint: ${params.style.trim()}`);
  }
  if (params.continuityNotes?.trim()) {
    lines.push(`Extra constraints: ${params.continuityNotes.trim()}`);
  }
  lines.push("Story request:", params.prompt.trim());
  return lines.join("\n");
}

function buildBookProfileReviewPrompt(params: {
  title: string;
  language: string;
  prompt: string;
  profile: BookProfile;
}): string {
  return [
    "You are a senior fiction editor reviewing a book-level setup.",
    `Write in ${params.language}.`,
    "Return only an editorial review report in markdown.",
    "Use short headings and concise bullets.",
    "Review the setup for commercial clarity, target-reader fit, differentiation, internal coherence, scalability for a long-form novel, and hook strength.",
    "Focus on the fields target users, market position, selling points, core theme, premise, world setup, and character setup.",
    "Point out weak, generic, overlapping, or contradictory setup choices.",
    "End with a concrete revision plan.",
    "",
    "Book setup to review:",
    buildBookProfileSubject(params.profile),
    "",
    "Review request:",
    params.prompt.trim(),
  ].join("\n");
}

function buildBookProfileRevisePrompt(params: {
  title: string;
  language: string;
  prompt: string;
  profile: BookProfile;
}): string {
  return [
    "You revise commercial-fiction book setups.",
    `Write in ${params.language}.`,
    "Return one JSON object only. No markdown fences, no commentary.",
    "Required JSON keys: targetUsers, marketPosition, sellingPoints, coreTheme, premise, worldSetup, characterSetup.",
    "Keep the same book identity unless the request explicitly changes direction.",
    "Strengthen reader fit, differentiation, internal logic, and long-form scalability.",
    "",
    "Current book setup:",
    buildBookProfileSubject(params.profile),
    "",
    "Revision request:",
    params.prompt.trim(),
  ].join("\n");
}

function parseGeneratedBookProfile(raw: string | undefined): BookProfilePatch | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/\{[\s\S]*\}/u);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const get = (key: string) => {
      const value = parsed[key];
      return typeof value === "string" ? value.trim() : undefined;
    };
    return {
      targetUsers: get("targetUsers"),
      marketPosition: get("marketPosition"),
      sellingPoints: get("sellingPoints"),
      coreTheme: get("coreTheme"),
      premise: get("premise"),
      worldSetup: get("worldSetup"),
      characterSetup: get("characterSetup"),
    };
  } catch {
    return null;
  }
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  return (payloads ?? [])
    .filter((payload) => !payload.isError && typeof payload.text === "string")
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function estimateWordCount(text: string, language: string): number {
  if (!text.trim()) {
    return 0;
  }
  if (language.toLowerCase().startsWith("zh")) {
    return text.replace(/\s+/gu, "").length;
  }
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function buildPrompt(params: {
  mode: NovelWriterMode;
  title?: string;
  chapterTitle?: string;
  chapterIndex?: number;
  prompt: string;
  style?: string;
  audience?: string;
  language: string;
  genre?: string;
  wordTarget?: number;
  openingChapter?: boolean;
  hookStrength: "low" | "medium" | "high";
  continuityNotes?: string;
  existingText?: string;
  bookProfile?: BookProfile | null;
  recentChapters?: string[];
}): string {
  const genreProfile = params.genre ? GENRE_PROFILES[params.genre] : undefined;
  const lines = [
    params.mode === "review" ? "You are a senior fiction editor." : "You are a senior novelist.",
    `Write in ${params.language}.`,
    `Mode: ${params.mode}.`,
    ...(params.mode === "review"
      ? [
          "Return only an editorial review report.",
          "Do not rewrite the scene unless the task explicitly asks for micro examples.",
          "Use short markdown headings and concise bullets.",
          "Focus on narrative clarity, hook strength, POV control, continuity, causality, scene tension, and anti-cliche quality.",
          "Call out where the draft sounds generic, over-explained, emotionally blunt, or mechanically AI-written.",
          "Prioritize the biggest craft issues first. Do not pad with compliments.",
          "End with a short revision plan the author can execute next.",
        ]
      : [
          "Return only the novel content itself.",
          "Do not include explanations, bullet points, planning notes, or markdown fences.",
          "Keep narrative voice consistent, concrete, and emotionally readable.",
          "Strictly isolate POV knowledge: a character can know only what they directly experienced, inferred, or learned.",
          "Maintain character fidelity: actions, dialogue, power level, emotion, and judgment must stay consistent with setup and current state.",
          "Preserve causal continuity: injuries, fatigue, resources, geography, and time passage must continue to matter until resolved.",
          "Show, do not merely tell, in high-stakes scenes: use body response, environment, and behavior instead of blunt emotion labels.",
          "Avoid AI-sounding filler, cliche metaphors, empty transitions, and generic summary prose.",
          "Avoid deus ex machina: no unforeshadowed rescue, miracle fix, or free power-up.",
          "Make dialogue partially indirect and socially real: not every line should transmit 100% clear information.",
          "Use selective sensory emphasis instead of evenly describing every sense in every paragraph.",
          "Each chapter or scene should end with a hook, turn, emotional aftershock, or unresolved pressure.",
        ]),
  ];
  if (genreProfile) {
    lines.push(
      `Genre profile: ${genreProfile.label}.`,
      `Genre role: ${genreProfile.role}`,
      "Genre aesthetics:",
      ...genreProfile.aesthetics.map((item) => `- ${item}`),
      "Genre taboos:",
      ...genreProfile.taboos.map((item) => `- ${item}`),
    );
  }
  if (params.bookProfile) {
    lines.push(
      "Stored book setup:",
      `- Target users: ${params.bookProfile.targetUsers || params.bookProfile.audience || ""}`,
      `- Market position: ${params.bookProfile.marketPosition || ""}`,
      `- Selling points: ${params.bookProfile.sellingPoints || ""}`,
      `- Core theme: ${params.bookProfile.coreTheme || ""}`,
      `- Premise: ${params.bookProfile.premise || ""}`,
      `- World setup: ${params.bookProfile.worldSetup || ""}`,
      `- Character setup: ${params.bookProfile.characterSetup || ""}`,
    );
  }
  if ((params.recentChapters?.length ?? 0) > 0) {
    lines.push("Recent chapter context:", ...(params.recentChapters ?? []));
  }
  if (params.title?.trim()) {
    lines.push(`Novel title: ${params.title.trim()}`);
  }
  if (params.chapterTitle?.trim()) {
    lines.push(`Chapter title: ${params.chapterTitle.trim()}`);
  }
  if (params.chapterIndex) {
    lines.push(`Chapter number: ${params.chapterIndex}`);
  }
  if (params.style?.trim()) {
    lines.push(`Style direction: ${params.style.trim()}`);
  }
  if (params.audience?.trim()) {
    lines.push(`Target audience: ${params.audience.trim()}`);
  }
  if (params.continuityNotes?.trim()) {
    lines.push("Continuity constraints:", params.continuityNotes.trim());
  }
  if (params.wordTarget) {
    lines.push(`Approximate target length: ${params.wordTarget} words/characters.`);
  }
  if (params.openingChapter) {
    lines.push(
      `Opening chapter hook strength: ${params.hookStrength}.`,
      "Opening-chapter protocol:",
      "- Start inside conflict, pressure, or unresolved tension. No flat daily-life opening.",
      "- Establish a distinctive protagonist impression within the first movement.",
      "- Introduce the world through action, scene, and dialogue rather than exposition dump.",
      "- Make the first section hard to stop reading.",
    );
  }
  if (params.mode === "continue" || params.mode === "rewrite" || params.mode === "revise") {
    lines.push(
      "Continuation protocol:",
      "- Preserve existing voice, continuity, and established facts unless the task explicitly requests revision.",
      "- Do not repeat already-known discoveries or replay prior emotional beats without a new turn.",
    );
  }
  if (params.mode === "review") {
    lines.push(
      "Editorial review protocol:",
      "- Assess opening hook, scene objective, conflict pressure, and chapter-ending traction.",
      "- Check POV leakage, continuity breaks, generic exposition, pacing drag, and unearned emotional lines.",
      "- Distinguish high-severity issues from polish-level edits.",
      "- When helpful, quote only short snippets from the draft.",
    );
  }
  if (params.mode === "chapter" || params.mode === "scene") {
    lines.push(
      "Drafting protocol:",
      "- Prefer a non-obvious but logically sound turn over the most generic expected move.",
      "- Every scene should advance plot, deepen relationship, or intensify atmosphere. Ideally more than one at once.",
      "- Keep action grounded in physical resistance and cost.",
    );
  }
  if (params.mode === "outline") {
    lines.push(
      "Outline protocol:",
      "- Produce a fiction-writing outline, not prose paragraphs.",
      "- Focus on conflict flow, point-of-view control, causality, and hook design.",
    );
  }
  if (params.mode === "revise") {
    lines.push(
      "Revision protocol:",
      "- Rewrite the draft into a cleaner, stronger version rather than appending notes.",
      "- Preserve the core events and intent unless the task explicitly asks for structural change.",
      "- Fix hook weakness, pacing drag, on-the-nose emotion, generic imagery, and continuity slips.",
      "- Keep the revised output publishable prose, not a comparison diff.",
    );
  }
  lines.push("", "Writing task:", params.prompt.trim());
  if (params.existingText?.trim()) {
    lines.push(
      "",
      params.mode === "review"
        ? "Draft to review:"
        : params.mode === "revise"
          ? "Draft to revise:"
          : "Existing draft to continue or rewrite from:",
      params.existingText.trim(),
    );
  }
  return lines.join("\n");
}

export function createNovelWriterTool(api: OpenClawPluginApi, context?: OpenClawPluginToolContext) {
  return {
    name: "novel_writer",
    label: "Novel Writer",
    description:
      "Write long-form fiction, scenes, chapters, or outlines with Gemini 3.1 Pro using the configured Gemini API key.",
    parameters: NovelWriterToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const prompt = readStringParam(rawParams, "prompt", { required: true }).trim();
      if (!prompt) {
        throw new ToolInputError("prompt is required");
      }
      if (prompt.length > MAX_PROMPT_CHARS) {
        throw new ToolInputError(`prompt is too long; maximum is ${MAX_PROMPT_CHARS} characters`);
      }

      const existingText = readStringParam(rawParams, "existingText");
      if (existingText && existingText.length > MAX_EXISTING_TEXT_CHARS) {
        throw new ToolInputError(
          `existingText is too long; maximum is ${MAX_EXISTING_TEXT_CHARS} characters`,
        );
      }

      const pluginConfig = (api.pluginConfig ?? {}) as NovelWriterPluginConfig;
      const model = normalizeModelRef(
        readStringParam(rawParams, "model") ?? pluginConfig.model ?? process.env.LLM_MODEL,
        DEFAULT_MODEL,
      );
      const [provider, ...modelParts] = model.split("/");
      const modelId = modelParts.join("/");
      if (!provider || !modelId) {
        throw new ToolInputError(`invalid model reference: ${model}`);
      }

      const language = normalizeLanguage(
        readStringParam(rawParams, "language") ?? pluginConfig.language,
        DEFAULT_LANGUAGE,
      );
      const genre = normalizeGenre(readStringParam(rawParams, "genre") ?? pluginConfig.genre);
      const thinking = normalizeThinking(
        readStringParam(rawParams, "thinking") ?? pluginConfig.thinking,
      );
      const mode = normalizeMode(readStringParam(rawParams, "mode")) as NovelWriterMode;
      const title = readStringParam(rawParams, "title");
      if (mode === "setup" && !title?.trim()) {
        throw new ToolInputError("title is required for setup mode");
      }
      const shouldSave = rawParams.save === undefined ? DEFAULT_SAVE : rawParams.save === true;
      const workspaceDir = context?.workspaceDir?.trim() || process.cwd();
      const outputDir = resolveOutputDir(workspaceDir, title);
      const chapterIndex = await resolveNextChapterIndex(
        outputDir,
        normalizePositiveInteger(rawParams, "chapterIndex"),
      );
      const wordTarget = normalizePositiveInteger(rawParams, "wordTarget");
      const maxTokens =
        normalizePositiveInteger(rawParams, "maxTokens") ??
        (typeof pluginConfig.maxTokens === "number" && pluginConfig.maxTokens > 0
          ? Math.floor(pluginConfig.maxTokens)
          : undefined);
      const timeoutMs =
        readNumberParam(rawParams, "timeoutMs", { integer: true }) ??
        (typeof pluginConfig.timeoutMs === "number" && pluginConfig.timeoutMs > 0
          ? Math.floor(pluginConfig.timeoutMs)
          : DEFAULT_TIMEOUT_MS);
      if (timeoutMs <= 0) {
        throw new ToolInputError("timeoutMs must be greater than 0");
      }
      const contextChapters = normalizeNonNegativeInteger(rawParams, "contextChapters");
      const existingProfile = title ? await loadBookProfile(outputDir) : null;
      const requestedAudience = readStringParam(rawParams, "audience");
      const requestedTargetUsers = readStringParam(rawParams, "targetUsers");
      const requestedMarketPosition = readStringParam(rawParams, "marketPosition");
      const requestedSellingPoints = readStringParam(rawParams, "sellingPoints");
      const requestedCoreTheme = readStringParam(rawParams, "coreTheme");
      const requestedWorldSetup = readStringParam(rawParams, "worldSetup");
      const requestedCharacterSetup = readStringParam(rawParams, "characterSetup");
      const requestedStyle = readStringParam(rawParams, "style");
      const requestedContinuityNotes = readStringParam(rawParams, "continuityNotes");
      let autoGeneratedProfile: Pick<
        BookProfile,
        | "targetUsers"
        | "marketPosition"
        | "sellingPoints"
        | "coreTheme"
        | "premise"
        | "worldSetup"
        | "characterSetup"
      > | null = null;
      if (title?.trim() && mode !== "setup" && !existingProfile) {
        const setupResult = await api.runtime.agent.runEmbeddedPiAgent({
          sessionId: `novel-writer-setup-${randomUUID()}`,
          sessionFile: path.join(os.tmpdir(), `openclaw-novel-setup-${randomUUID()}.json`),
          workspaceDir,
          config: api.config,
          prompt: buildAutoSetupPrompt({
            title: title.trim(),
            prompt,
            language,
            genre,
            audience: requestedAudience,
            style: requestedStyle,
            continuityNotes: requestedContinuityNotes,
          }),
          timeoutMs: Math.min(timeoutMs, 45_000),
          runId: `novel-writer-setup-${randomUUID()}`,
          provider,
          model: modelId,
          thinkLevel: "minimal",
          disableTools: true,
        });
        autoGeneratedProfile = parseGeneratedBookProfile(collectText(setupResult.payloads));
      }
      const recentChapters =
        title && mode !== "setup"
          ? await loadRecentChapterContext(
              outputDir,
              "",
              contextChapters ?? DEFAULT_CONTEXT_CHAPTERS,
            )
          : [];
      const now = new Date().toISOString();
      const nextProfile = title?.trim()
        ? ({
            title: title.trim(),
            language,
            genre,
            audience: requestedAudience ?? existingProfile?.audience,
            targetUsers:
              requestedTargetUsers ??
              existingProfile?.targetUsers ??
              autoGeneratedProfile?.targetUsers,
            marketPosition:
              requestedMarketPosition ??
              existingProfile?.marketPosition ??
              autoGeneratedProfile?.marketPosition,
            sellingPoints:
              requestedSellingPoints ??
              existingProfile?.sellingPoints ??
              autoGeneratedProfile?.sellingPoints,
            coreTheme:
              requestedCoreTheme ?? existingProfile?.coreTheme ?? autoGeneratedProfile?.coreTheme,
            premise: existingProfile?.premise ?? autoGeneratedProfile?.premise ?? prompt,
            worldSetup:
              requestedWorldSetup ??
              existingProfile?.worldSetup ??
              autoGeneratedProfile?.worldSetup,
            characterSetup:
              requestedCharacterSetup ??
              existingProfile?.characterSetup ??
              autoGeneratedProfile?.characterSetup,
            style: requestedStyle ?? existingProfile?.style,
            continuityNotes: requestedContinuityNotes ?? existingProfile?.continuityNotes,
            createdAt: existingProfile?.createdAt ?? now,
            updatedAt: now,
          } satisfies BookProfile)
        : null;
      const bookProfileTarget = nextProfile ?? existingProfile;
      const isBookProfileReviewOrRevise =
        (mode === "review" || mode === "revise") &&
        !existingText?.trim() &&
        hasEditableBookProfileContent(bookProfileTarget);
      if (
        (mode === "review" || mode === "revise") &&
        !existingText?.trim() &&
        !isBookProfileReviewOrRevise
      ) {
        throw new ToolInputError(
          "existingText is required for review and revise modes unless a book setup is available",
        );
      }
      let chapterTitle = readStringParam(rawParams, "chapterTitle");

      if (mode === "setup") {
        if (shouldSave && nextProfile) {
          await saveBookProfile(outputDir, nextProfile);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Book setup saved for ${title?.trim()}.`,
            },
          ],
          details: {
            mode,
            ...(nextProfile ? { bookProfilePath: path.join(outputDir, "_book.json") } : {}),
          },
        };
      }

      if (isBookProfileReviewOrRevise && bookProfileTarget) {
        const profilePrompt =
          mode === "review"
            ? buildBookProfileReviewPrompt({
                title: bookProfileTarget.title,
                language,
                prompt,
                profile: bookProfileTarget,
              })
            : buildBookProfileRevisePrompt({
                title: bookProfileTarget.title,
                language,
                prompt,
                profile: bookProfileTarget,
              });
        const profileResult = await api.runtime.agent.runEmbeddedPiAgent({
          sessionId: `novel-writer-profile-${randomUUID()}`,
          sessionFile: path.join(os.tmpdir(), `openclaw-novel-profile-${randomUUID()}.json`),
          workspaceDir,
          config: api.config,
          prompt: profilePrompt,
          timeoutMs,
          runId: `novel-writer-profile-${randomUUID()}`,
          provider,
          model: modelId,
          thinkLevel: thinking,
          streamParams: {
            ...(maxTokens ? { maxTokens } : {}),
          },
          disableTools: true,
        });
        const text = collectText(profileResult.payloads);
        if (!text) {
          throw new Error("Novel writer returned empty output");
        }
        if (mode === "review") {
          let savedPath: string | undefined;
          if (shouldSave) {
            await fs.mkdir(outputDir, { recursive: true });
            const outputFileName = resolveOutputFileName(readStringParam(rawParams, "fileName"), {
              title,
              chapterTitle: "book-setup-review",
              mode,
              chapterIndex: undefined,
            });
            savedPath = path.join(outputDir, outputFileName);
            await fs.writeFile(savedPath, `${text.trim()}\n`, "utf8");
          }
          return {
            content: [{ type: "text" as const, text }],
            details: {
              provider,
              model: modelId,
              language,
              reviewTarget: "book_setup",
              ...(savedPath ? { savedPath } : {}),
              ...(title ? { bookProfilePath: path.join(outputDir, "_book.json") } : {}),
            },
          };
        }

        const profilePatch = parseGeneratedBookProfile(text);
        if (!profilePatch) {
          throw new Error("Novel writer returned invalid book setup revision JSON");
        }
        const revisedProfile: BookProfile = {
          ...bookProfileTarget,
          ...profilePatch,
          updatedAt: new Date().toISOString(),
        };
        if (shouldSave) {
          await saveBookProfile(outputDir, revisedProfile);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: buildBookProfileMarkdown(revisedProfile),
            },
          ],
          details: {
            provider,
            model: modelId,
            language,
            reviewTarget: "book_setup",
            ...(title ? { bookProfilePath: path.join(outputDir, "_book.json") } : {}),
          },
        };
      }

      if (shouldSave && nextProfile && !existingProfile) {
        await saveBookProfile(outputDir, nextProfile);
      }

      if (shouldAutoGenerateChapterTitle(mode, chapterTitle)) {
        const titleResult = await api.runtime.agent.runEmbeddedPiAgent({
          sessionId: `novel-writer-title-${randomUUID()}`,
          sessionFile: path.join(os.tmpdir(), `openclaw-novel-title-${randomUUID()}.json`),
          workspaceDir,
          config: api.config,
          prompt: buildChapterTitlePrompt({
            title,
            chapterIndex,
            prompt,
            language,
            genre,
            bookProfile: nextProfile ?? existingProfile,
            recentChapters,
          }),
          timeoutMs: Math.min(timeoutMs, 30_000),
          runId: `novel-writer-title-${randomUUID()}`,
          provider,
          model: modelId,
          thinkLevel: "minimal",
          disableTools: true,
        });
        chapterTitle =
          normalizeGeneratedChapterTitle(collectText(titleResult.payloads)) ?? chapterTitle;
      }

      const outputFileName = resolveOutputFileName(readStringParam(rawParams, "fileName"), {
        title,
        chapterTitle,
        mode,
        chapterIndex,
      });

      const runPrompt = buildPrompt({
        mode,
        title,
        chapterTitle,
        chapterIndex,
        prompt,
        style: readStringParam(rawParams, "style"),
        audience: requestedAudience,
        language,
        genre,
        wordTarget,
        openingChapter: rawParams.openingChapter === true,
        hookStrength: normalizeHookStrength(readStringParam(rawParams, "hookStrength")),
        continuityNotes: requestedContinuityNotes,
        existingText,
        bookProfile: nextProfile ?? existingProfile,
        recentChapters,
      });

      let tempDir: string | null = null;
      try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-novel-writer-"));
        const sessionId = `novel-writer-${randomUUID()}`;
        const sessionFile = path.join(tempDir, "session.json");
        const result = await api.runtime.agent.runEmbeddedPiAgent({
          sessionId,
          sessionFile,
          workspaceDir,
          config: api.config,
          prompt: runPrompt,
          timeoutMs,
          runId: `novel-writer-${randomUUID()}`,
          provider,
          model: modelId,
          thinkLevel: thinking,
          streamParams: {
            ...(maxTokens ? { maxTokens } : {}),
          },
          disableTools: true,
        });

        const text = collectText(result.payloads);
        if (!text) {
          throw new Error("Novel writer returned empty output");
        }
        let savedPath: string | undefined;
        if (shouldSave) {
          if (nextProfile && existingProfile) {
            await saveBookProfile(outputDir, nextProfile);
          }
          await fs.mkdir(outputDir, { recursive: true });
          savedPath = path.join(outputDir, outputFileName);
          await fs.writeFile(savedPath, `${text.trim()}\n`, "utf8");
        }

        return {
          content: [{ type: "text" as const, text }],
          details: {
            provider,
            model: modelId,
            language,
            ...(genre ? { genre } : {}),
            ...(chapterTitle ? { chapterTitle } : {}),
            estimatedLength: estimateWordCount(text, language),
            ...(savedPath ? { savedPath } : {}),
          },
        };
      } finally {
        if (tempDir) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };
}
