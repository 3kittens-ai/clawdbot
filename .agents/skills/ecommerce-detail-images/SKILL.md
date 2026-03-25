---
name: ecommerce-detail-images
description: Plan and generate ecommerce detail-page image sets for product listings, marketplaces, and sales channels. Use when OpenClaw needs to turn product text, reference photos, or rough requirements into a consistent set of main images, selling-point images, parameter images, scene images, or poster-style detail assets, especially when Gemini image generation or image editing should be used.
---

# Ecommerce Detail Images

Use this skill to turn a product brief or product photos into a usable ecommerce image set.

Prefer the existing `gemini_image` tool for execution. Use `action="describe"` first when the product, packaging, or source photo is unclear. Then generate or edit the required image set with short iterative passes instead of one oversized prompt.

## Workflow

1. Extract the minimum product facts before generating.
   Product category, hero SKU, visible materials, colors, dimensions, selling points, target audience, channel, and aspect ratio matter more than long brand storytelling.

2. Decide whether to start from description, edit, or generation.

- Use `gemini_image` with `action="describe"` when the user sends product photos, packaging photos, or competitor screenshots.
- Use `action="edit"` when the user wants to preserve product shape, angle, packaging, or lighting from a source image.
- Use `action="generate"` when the user wants a fresh composition or does not have a usable source image.

3. Choose the deliverable set before prompting.
   Default ecommerce deliverables:

- Main image: clean hero product shot, simple composition, strong readability.
- Selling-point image: one key feature with visual focus and supporting copy area.
- Parameter image: dimensions, capacity, materials, or technical specs with a layout area for labels.
- Scene image: product in a realistic usage context.
- Poster/detail header: more expressive hero visual for the top of a detail page.

4. Generate one image purpose at a time.
   Do not ask Gemini for a whole detail-page set in one prompt. Generate separate images for separate jobs so composition stays controllable.

5. Inspect and iterate with narrow edits.
   If the product identity is correct but layout is wrong, keep the same source and use `action="edit"` with one clear change request. If the product identity is wrong, regenerate with a stricter object description.

## Prompt Rules

Always specify:

- Product type and hero object
- Visual goal for this image
- Background and environment
- Camera angle or composition
- Style level: realistic product photography, clean commercial poster, premium studio light, etc.
- Reserved text area if copy will be added later
- What must stay accurate

Always avoid:

- Wrong brand marks or fake logos unless explicitly requested
- Dense unreadable text inside the generated image
- Overdecorated props that hide the product
- Unrealistic materials, impossible reflections, or distorted proportions
- Mixing multiple selling points into one crowded image

When Chinese ecommerce output is intended, say so explicitly. Prefer "reserve copy area" over asking the model to render long Chinese paragraphs directly. Generate clean layouts first; add final marketing copy later if needed.

## Chinese Copy Structure

For Chinese ecommerce detail images, prefer short structured copy blocks instead of long paragraphs inside the generated image.

Use this hierarchy:

- Title: 6 to 12 Chinese characters. State the core benefit or hero feature.
- Subtitle: 8 to 18 Chinese characters. Add one supporting fact, scene, or product quality cue.
- Support bullets: 2 to 4 short fragments, usually 4 to 8 Chinese characters each.

Good title patterns:

- 4-hour strong insulation
- Lightweight folding storage
- One-button quick opening
- Skin-friendly breathable fabric

Good subtitle patterns:

- Office commute all-day temperature lock
- Compact body fits bags and cup holders
- Stable support for repeated daily use

Rules:

- Use one main claim per image.
- Do not stack multiple promotional slogans in the same frame.
- Prefer concrete benefit wording over vague adjectives.
- If the model is only generating the background layout, explicitly ask it to reserve title and subtitle areas rather than render all final Chinese copy.

## Image Types

### Main Image

Goal: show the product clearly and sell click-through.

Requirements:

- Product occupies the visual center
- Background stays simple
- Lighting emphasizes texture and silhouette
- No clutter

Good use cases:

- Marketplace cover
- PDP hero image
- Listing thumbnail variant

### Selling-Point Image

Goal: express one reason to buy.

Requirements:

- One feature only
- Visual evidence of the feature
- Leave safe space for headline and short subcopy
- Keep product recognizable

Examples:

- Thermal retention
- Waterproof material
- Foldable structure
- Skin-friendly fabric

### Parameter Image

Goal: support specs and comparison reading.

Requirements:

- Clean front or side layout
- Measurable geometry
- Neutral background
- Space for arrows, labels, and dimensions

Prefer editing from a clean product render or photo when precision matters.

### Scene Image

Goal: show use context and audience fit.

Requirements:

- Scene supports the product instead of overpowering it
- Product remains clearly visible
- Mood matches the product tier
- Avoid generic stock-photo chaos

### Poster or Detail Header

Goal: set the page tone and present the strongest branded visual.

Requirements:

- Strong composition
- Clear hero focus
- Atmospheric but still commercial
- Space for title or campaign line

## Execution Patterns

### Pattern 1: Reference-first

Use when the user provides product photos.

1. Run `gemini_image` with `action="describe"` on the best product image.
2. Summarize the stable product facts.
3. Run `gemini_image` with `action="edit"` to preserve shape and identity.
4. Iterate on background, lighting, and composition only.

### Pattern 2: Fresh generation

Use when the user provides only text requirements.

1. Write a strict product identity sentence.
2. Add one image purpose.
3. Add composition and lighting.
4. Add reserved layout area.
5. Generate only one target image type.

### Pattern 3: Mixed set

Use when the user wants a full detail-page package.

1. Define the set order: main image, selling-point image, parameter image, scene image.
2. Keep the same product identity wording across prompts.
3. Change only the purpose, background, and composition between images.

### Pattern 4: Standard 4-image ecommerce pack

Use when the user says they want "a detail-page set", "一套详情图", "主图加详情图", or similar.

Default output:

1. Main image
2. Selling-point image A
3. Selling-point image B or parameter image
4. Scene image

Default execution order:

1. Lock product identity from text or source photo.
2. Generate or edit the main image first.
3. Reuse the same identity wording for image 2 to image 4.
4. Keep each detail image focused on exactly one purpose.
5. End with a short summary naming what each image is for.

Recommended focus split:

1. Main image: product-first, clean hero composition.
2. Selling-point image A: strongest buying reason.
3. Selling-point image B or parameter image: second feature or measurable specs.
4. Scene image: audience and use context.

## Channel-Friendly Defaults

When the request comes from a chat channel and is underspecified, assume:

- Realistic commercial photography
- Clean ecommerce layout
- Product-first composition
- Minimal embedded text
- Aspect ratio `3:4` for portrait product assets unless the user asks otherwise

When the user sends an image without much text, first describe it, then propose the next generation or edit step in one short sentence before running it.

## Platform Ratio Presets

Use these presets unless the user gives a different ratio:

- Taobao or Tmall main/detail portrait assets: `3:4`
- Xiaohongshu commerce covers: `3:4`
- Douyin product promo portraits: `9:16`
- WeChat article or share covers: `16:9`
- Square marketplace cards or comparison blocks: `1:1`
- Wide detail-page headers or hero banners: `16:9`

If the channel is unknown, default to `3:4` for product-centric images and `16:9` for header-style images.

## One-line Channel Templates

Use these when the user writes short chat-style requests in Feishu, WeChat, or similar direct-message channels. Expand them into a structured 4-step workflow and execute image generation directly instead of asking the user to restate everything.

Examples:

- "用这张图做一套详情页，主图加三张详情图，中文电商风"
- "给这个杯子出淘宝详情图，主图、卖点图、参数图、场景图"
- "按飞书里这张产品图，做一套中文详情页素材，保留产品结构"
- "按微信这张图出详情图，主图加三张，淘宝 3:4"
- "给这个产品做小红书电商图，封面和三张详情图"

Interpretation rules:

- "一套详情图" defaults to the standard 4-image pack.
- "中文电商风" means reserve clear Chinese title and subtitle areas.
- "保留产品结构" means prefer `action="edit"` over fresh generation.
- "主图加三张详情图" maps directly to the standard 4-image workflow.

Execution rule:

- If the user says `出图`, `详情图`, `主图`, `主图加三张`, `详情页`, or equivalent, do not stop at copywriting, layout advice, or planning text.
- Call `gemini_image` in the same turn unless the plugin/tool is unavailable.
- Only fall back to text-only guidance when image generation is impossible, and explicitly say why.

## Fixed Channel Command Phrases

When the user writes a short Feishu or WeChat message, treat the following as fixed command-style intents and execute directly unless critical product information is missing.

Preferred command phrases:

- `出详情图`
- `出一套详情图`
- `出主图加三张详情图`
- `做淘宝详情图`
- `做小红书电商图`
- `按这张图出详情页`
- `保留产品结构出详情图`

Recommended parsing pattern:

- Product source: text brief or attached image
- Platform: Taobao, Tmall, Xiaohongshu, Douyin, WeChat, or unspecified
- Pack size: default 4 images unless explicitly changed
- Identity mode: preserve source structure when an image is attached and the wording implies continuity

Examples:

- `给这个杯子出详情图`
  Default to standard 4-image pack, `3:4`, product-first Chinese ecommerce style.
- `按这张图出主图加三张详情图`
  Use `describe` first, then `edit`, preserve product identity.
- `做小红书电商图`
  Prefer stronger cover aesthetics, still keep ecommerce readability.
- `保留产品结构出详情图`
  Treat source image structure as fixed and avoid fresh product redesign.

If the message is command-like but underspecified, do not block on minor missing details. Use the channel defaults from this skill and proceed.

## Attached Image Rule

When the message includes an attached image or a quoted/referenced image:

- Treat that image as the default source image without asking the user to restate it.
- Run `gemini_image` with `action="describe"` first only when product identity is unclear.
- Otherwise go straight to `action="edit"` and preserve product structure.

When the message does not include an image:

- Use `action="generate"` and keep the product identity strict.
- If the user wrote `按这张图` but no image actually reached the session, ask for the image again in one short sentence instead of inventing details.

## Output Format

After generating a set, summarize the result in a short channel-friendly format:

1. Main image: what it is for
2. Detail image 1: what claim it covers
3. Detail image 2: what claim or specs it covers
4. Detail image 3: what scene or audience it covers

Keep this summary short enough to send cleanly in Feishu or other chat channels.

## Naming Convention

When a standard set is generated, name files in a stable, sortable pattern so the user can immediately tell their role.

Default pattern:

`[product-slug]_[platform]_[index]_[role].[ext]`

Rules:

- `product-slug`: short lowercase pinyin or English slug, 2 to 6 words max
- `platform`: `tb`, `tmall`, `xhs`, `dy`, `wx`, or `generic`
- `index`: `01`, `02`, `03`, `04`
- `role`: `main`, `feature-a`, `spec`, `scene`, or another precise role label

Default standard 4-image mapping:

- `01_main`
- `02_feature-a`
- `03_spec`
- `04_scene`

Examples:

- `baowenbei_tb_01_main.png`
- `baowenbei_tb_02_feature-a.png`
- `baowenbei_tb_03_spec.png`
- `baowenbei_tb_04_scene.png`
- `sports-bottle_xhs_01_main.png`

If the product name is unknown, use a generic slug based on category:

- `tumbler`
- `backpack`
- `water-bottle`
- `skin-care`

If the platform is unknown, use `generic`.

When returning the result in chat, mention the intended names in the summary even if the underlying tool saved media files with managed storage paths.

## References

For reusable prompt skeletons and deliverable templates, read [prompt-templates.md](references/prompt-templates.md).
