# Prompt Templates

Use these as compact building blocks. Keep the product identity sentence stable across a multi-image set.

## Product Identity Sentence

Format:

`A realistic [product type], [color/material], [shape/form factor], accurate proportions, commercial product photography.`

Example:

`A realistic stainless-steel insulated tumbler, matte black body, slim cylindrical shape, accurate lid structure, commercial product photography.`

## Main Image Template

`[Product identity sentence]. Create a clean ecommerce main image. White or very light background, premium studio lighting, centered composition, sharp material texture, no clutter, no fake brand marks, reserve a small clean area for later headline placement.`

Chinese structure suggestion:

- Title area: top-left or top-center
- Subtitle area: directly under title
- Supporting fragments: optional, kept minimal

## Selling-Point Image Template

`[Product identity sentence]. Create a selling-point image focused on [single feature]. Show visual evidence of the feature, keep the product dominant, clean commercial composition, controlled background, reserve a clear headline area and a smaller subcopy area, do not overcrowd the frame.`

Chinese structure suggestion:

- Title: one benefit line
- Subtitle: one support line
- Optional 2 to 3 short tags

## Parameter Image Template

`[Product identity sentence]. Create a clean parameter/specification image. Neutral background, front or side product view with precise geometry, space for labels, arrows, dimensions, and material callouts, technical and readable ecommerce style.`

## Scene Image Template

`[Product identity sentence]. Create a realistic lifestyle scene image for [target audience/use case]. Keep the product clearly visible, believable environment, premium lighting, natural props only, product remains the visual anchor.`

## Poster/Header Template

`[Product identity sentence]. Create a premium ecommerce detail-page hero poster. Strong composition, atmospheric but clean background, dramatic commercial lighting, high-end visual tone, reserve a prominent title area, avoid clutter and avoid fake text blocks.`

## Edit Template

Use when preserving source identity matters.

`Keep the product identity, proportions, and core structure from the source image. Change only [background/composition/lighting/layout/use scene]. Target output: [main image / selling-point image / parameter image / scene image / poster]. Maintain realistic materials and accurate product details.`

## Describe Template

Use before editing when the source image is unclear.

`Describe the product identity, visible materials, colors, structural details, camera angle, background, packaging, and any text or labels that appear. Then summarize what details must stay unchanged in future edits.`

## Fast Brief Template

Use to structure a user request before prompting:

- Product:
- Audience:
- Channel:
- Image type:
- Key selling point:
- Must keep:
- Must avoid:
- Aspect ratio:

## Chinese Title and Subtitle Template

Use this as a copy planning skeleton before prompting:

- Title:
- Subtitle:
- Support fragments:

Example:

- Title: 4小时长效保温
- Subtitle: 通勤办公随时喝到顺口温度
- Support fragments: 锁温稳定 / 防漏杯盖 / 轻松随行

## Standard 4-image Pack Template

Use this sequence when the user wants a default ecommerce set:

### Image 1: Main image

`[Product identity sentence]. Create a clean ecommerce main image for a Chinese product detail page. [Aspect ratio]. Premium studio light, simple background, strong product focus, reserve title and subtitle areas, realistic materials, no clutter.`

### Image 2: Selling-point image

`[Product identity sentence]. Create a Chinese ecommerce selling-point image focused on [core benefit]. [Aspect ratio]. Show the feature visually, keep product dominant, reserve title and subtitle areas, clean commercial layout.`

### Image 3: Parameter or second selling-point image

`[Product identity sentence]. Create a Chinese ecommerce parameter image focused on [specs or second feature]. [Aspect ratio]. Clean technical layout, accurate geometry, reserved areas for labels and dimension text, easy to read.`

### Image 4: Scene image

`[Product identity sentence]. Create a Chinese ecommerce scene image for [audience/use case]. [Aspect ratio]. Realistic lifestyle environment, product remains the visual anchor, premium but believable composition, reserve title area if needed.`

## Feishu One-line Expansion Template

When the user sends a short Feishu-style request, expand it internally into:

1. Product identity sentence
2. Channel and ratio preset
3. Standard 4-image pack or requested subset
4. Chinese title and subtitle placeholders for each image

Example expansion:

Input:
`给这个杯子出淘宝详情图，主图、卖点图、参数图、场景图`

Internal plan:

- Channel: Taobao
- Ratio: 3:4
- Pack: standard 4-image pack
- Product identity: stainless-steel insulated tumbler, accurate lid and body structure
- Image order: main, feature, parameter, scene

## Fixed Command Expansion Cheatsheet

Use these direct expansions when the message looks like a Feishu command:

### `出详情图`

Expand to:

- standard 4-image pack
- Chinese ecommerce style
- default ratio by platform or `3:4`

### `出主图加三张详情图`

Expand to:

- image 1: main
- image 2: feature
- image 3: spec or feature B
- image 4: scene

### `按这张图出详情页`

Expand to:

- run `describe`
- preserve product identity
- use `edit` for the generated set

### `保留产品结构出详情图`

Expand to:

- do not redesign the product shape
- keep visible structure, lid, packaging, and proportions
- only change layout, background, scene, and lighting

## Naming Template

Before executing a standard set, derive a naming plan:

- Slug:
- Platform:
- 01:
- 02:
- 03:
- 04:

Example:

- Slug: baowenbei
- Platform: tb
- 01: baowenbei_tb_01_main
- 02: baowenbei_tb_02_feature-a
- 03: baowenbei_tb_03_spec
- 04: baowenbei_tb_04_scene
