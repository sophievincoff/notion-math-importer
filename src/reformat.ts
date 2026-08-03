import "dotenv/config";

import { Client } from "@notionhq/client";
import type {
  BlockObjectRequest,
  RichTextItemRequest,
  RichTextItemResponse,
  UpdateBlockParameters,
} from "@notionhq/client/build/src/api-endpoints.js";
import process from "node:process";

import {
  HEADING_TYPES,
  headingIsToggleable,
  headingLevel,
  normalizeNotionId,
  parentBlockId,
  retrieveAllChildren,
  tryValidateEquation,
  type SourceBlock,
} from "./notion-utils.js";

type Stats = {
  blocksUpdated: number;
  inlineConversions: number;
  displayConversions: number;
  invalidSkipped: number;
  warnings: string[];
};

type RewriteResult = {
  items: RichTextItemRequest[];
  changed: boolean;
  inlineConversions: number;
  displayConversions: number;
  invalidSkipped: number;
  warnings: string[];
  /** When the whole rich_text is one display equation (plus whitespace). */
  pureDisplayExpression: string | null;
};

const RICH_TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "to_do",
  "toggle",
  "callout",
  "template",
]);

const CONTAINER_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "to_do",
  "toggle",
  "callout",
  "column_list",
  "column",
  "synced_block",
  "table",
  "tab",
  "template",
]);

function usage(): never {
  console.error(`
Usage:
  npm run reformat -- --target PAGE_OR_BLOCK_URL_OR_ID
  npm run reformat -- --target PAGE_OR_BLOCK_URL_OR_ID --dry-run

Options:
  --target, -t   Page, heading, or toggle to reformat.
  --dry-run      Report planned math fixes without writing to Notion.
  --help, -h     Show this help.

Converts leftover plain-text math ($...$, $$...$$, \\(...\\), \\[...\\]) into
native Notion equation rich text and equation blocks.
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const result: { target?: string; dryRun?: boolean } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--target" || arg === "-t") {
      if (!value) usage();
      result.target = value;
      index += 1;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!result.target) usage();
  return result as { target: string; dryRun?: boolean };
}

type MathMatch = {
  start: number;
  end: number;
  expression: string;
  display: boolean;
};

function findMathMatches(text: string): MathMatch[] {
  const matches: MathMatch[] = [];
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("$$", index)) {
      const close = text.indexOf("$$", index + 2);
      if (close !== -1) {
        matches.push({
          start: index,
          end: close + 2,
          expression: text.slice(index + 2, close).trim(),
          display: true,
        });
        index = close + 2;
        continue;
      }
    }

    if (text.startsWith("\\[", index)) {
      const close = text.indexOf("\\]", index + 2);
      if (close !== -1) {
        matches.push({
          start: index,
          end: close + 2,
          expression: text.slice(index + 2, close).trim(),
          display: true,
        });
        index = close + 2;
        continue;
      }
    }

    if (text.startsWith("\\(", index)) {
      const close = text.indexOf("\\)", index + 2);
      if (close !== -1) {
        matches.push({
          start: index,
          end: close + 2,
          expression: text.slice(index + 2, close).trim(),
          display: false,
        });
        index = close + 2;
        continue;
      }
    }

    if (text[index] === "$" && text[index + 1] !== "$") {
      const close = text.indexOf("$", index + 1);
      if (close !== -1 && !text.slice(index + 1, close).includes("\n")) {
        const expression = text.slice(index + 1, close);
        if (expression.length > 0 && !/^\s/.test(expression) && !/\s$/.test(expression)) {
          matches.push({
            start: index,
            end: close + 1,
            expression: expression.trim(),
            display: false,
          });
          index = close + 1;
          continue;
        }
      }
    }

    index += 1;
  }

  return matches;
}

function annotationsFrom(
  item: RichTextItemResponse,
): NonNullable<RichTextItemRequest["annotations"]> {
  const { annotations } = item;
  return {
    bold: annotations.bold,
    italic: annotations.italic,
    strikethrough: annotations.strikethrough,
    underline: annotations.underline,
    code: annotations.code,
    color: annotations.color,
  };
}

function textRequest(
  content: string,
  annotations: NonNullable<RichTextItemRequest["annotations"]>,
  link: { url: string } | null,
): RichTextItemRequest | null {
  if (!content) return null;
  return {
    type: "text",
    text: {
      content,
      link,
    },
    annotations,
  };
}

function equationRequest(
  expression: string,
  annotations: NonNullable<RichTextItemRequest["annotations"]>,
): RichTextItemRequest {
  return {
    type: "equation",
    equation: { expression },
    annotations,
  };
}

function mentionToRequest(item: RichTextItemResponse): RichTextItemRequest {
  if (item.type !== "mention") {
    return {
      type: "text",
      text: { content: item.plain_text, link: null },
      annotations: annotationsFrom(item),
    };
  }

  const mention = item.mention;
  const annotations = annotationsFrom(item);

  if (mention.type === "user" && "id" in mention.user) {
    return {
      type: "mention",
      mention: { type: "user", user: { id: mention.user.id } },
      annotations,
    };
  }
  if (mention.type === "page") {
    return {
      type: "mention",
      mention: { type: "page", page: { id: mention.page.id } },
      annotations,
    };
  }
  if (mention.type === "database") {
    return {
      type: "mention",
      mention: { type: "database", database: { id: mention.database.id } },
      annotations,
    };
  }
  if (mention.type === "date") {
    return {
      type: "mention",
      mention: {
        type: "date",
        date: {
          start: mention.date.start,
          ...(mention.date.end ? { end: mention.date.end } : {}),
          ...(mention.date.time_zone ? { time_zone: mention.date.time_zone } : {}),
        },
      },
      annotations,
    };
  }

  return {
    type: "text",
    text: { content: item.plain_text, link: null },
    annotations,
  };
}

function responseItemToRequest(item: RichTextItemResponse): RichTextItemRequest {
  if (item.type === "text") {
    return {
      type: "text",
      text: {
        content: item.text.content,
        link: item.text.link,
      },
      annotations: annotationsFrom(item),
    };
  }
  if (item.type === "equation") {
    return equationRequest(item.equation.expression, annotationsFrom(item));
  }
  return mentionToRequest(item);
}

function rewriteTextContent(
  content: string,
  annotations: NonNullable<RichTextItemRequest["annotations"]>,
  link: { url: string } | null,
): {
  items: RichTextItemRequest[];
  inlineConversions: number;
  displayConversions: number;
  invalidSkipped: number;
  warnings: string[];
  displayExpressions: string[];
} {
  const matches = findMathMatches(content);
  if (matches.length === 0) {
    const item = textRequest(content, annotations, link);
    return {
      items: item ? [item] : [],
      inlineConversions: 0,
      displayConversions: 0,
      invalidSkipped: 0,
      warnings: [],
      displayExpressions: [],
    };
  }

  const items: RichTextItemRequest[] = [];
  const warnings: string[] = [];
  const displayExpressions: string[] = [];
  let inlineConversions = 0;
  let displayConversions = 0;
  let invalidSkipped = 0;
  let cursor = 0;

  for (const match of matches) {
    const before = textRequest(content.slice(cursor, match.start), annotations, link);
    if (before) items.push(before);

    if (!match.expression || !tryValidateEquation(match.expression)) {
      invalidSkipped += 1;
      warnings.push(match.expression || "(empty math)");
      const raw = textRequest(content.slice(match.start, match.end), annotations, link);
      if (raw) items.push(raw);
    } else {
      items.push(equationRequest(match.expression, annotations));
      if (match.display) {
        displayConversions += 1;
        displayExpressions.push(match.expression);
      } else {
        inlineConversions += 1;
      }
    }

    cursor = match.end;
  }

  const after = textRequest(content.slice(cursor), annotations, link);
  if (after) items.push(after);

  return {
    items,
    inlineConversions,
    displayConversions,
    invalidSkipped,
    warnings,
    displayExpressions,
  };
}

function isWhitespaceOnlyText(item: RichTextItemRequest): boolean {
  return item.type === "text" && !item.text.content.trim();
}

function rewriteRichText(items: RichTextItemResponse[]): RewriteResult {
  const output: RichTextItemRequest[] = [];
  let changed = false;
  let inlineConversions = 0;
  let displayConversions = 0;
  let invalidSkipped = 0;
  const warnings: string[] = [];
  const displayExpressions: string[] = [];

  for (const item of items) {
    if (item.type !== "text" || item.annotations.code) {
      output.push(responseItemToRequest(item));
      continue;
    }

    const rewritten = rewriteTextContent(
      item.text.content,
      annotationsFrom(item),
      item.text.link,
    );

    if (rewritten.inlineConversions > 0 || rewritten.displayConversions > 0) {
      changed = true;
    }

    inlineConversions += rewritten.inlineConversions;
    displayConversions += rewritten.displayConversions;
    invalidSkipped += rewritten.invalidSkipped;
    warnings.push(...rewritten.warnings);
    displayExpressions.push(...rewritten.displayExpressions);
    output.push(...rewritten.items);
  }

  let pureDisplayExpression: string | null = null;
  const meaningful = output.filter((item) => !isWhitespaceOnlyText(item));
  if (
    meaningful.length === 1 &&
    meaningful[0]?.type === "equation" &&
    displayExpressions.length === 1 &&
    displayExpressions[0] === meaningful[0].equation.expression
  ) {
    pureDisplayExpression = meaningful[0].equation.expression;
  }

  return {
    items: output,
    changed: changed || Boolean(pureDisplayExpression),
    inlineConversions,
    displayConversions,
    invalidSkipped,
    warnings,
    pureDisplayExpression,
  };
}

function getBlockRichText(
  block: SourceBlock & { type: string },
): RichTextItemResponse[] | null {
  const payload = (block as unknown as Record<string, unknown>)[block.type];
  if (!payload || typeof payload !== "object" || !("rich_text" in payload)) {
    return null;
  }
  const richText = (payload as { rich_text: unknown }).rich_text;
  if (!Array.isArray(richText)) return null;
  return richText as RichTextItemResponse[];
}

function getTableRowCells(
  block: SourceBlock & { type: string },
): RichTextItemResponse[][] | null {
  if (block.type !== "table_row") return null;
  const payload = (block as unknown as Record<string, { cells?: RichTextItemResponse[][] }>)
    .table_row;
  return payload?.cells ?? null;
}

function buildUpdateBody(
  blockId: string,
  type: string,
  richText: RichTextItemRequest[],
): UpdateBlockParameters {
  switch (type) {
    case "paragraph":
      return { block_id: blockId, type: "paragraph", paragraph: { rich_text: richText } };
    case "heading_1":
      return { block_id: blockId, type: "heading_1", heading_1: { rich_text: richText } };
    case "heading_2":
      return { block_id: blockId, type: "heading_2", heading_2: { rich_text: richText } };
    case "heading_3":
      return { block_id: blockId, type: "heading_3", heading_3: { rich_text: richText } };
    case "heading_4":
      return { block_id: blockId, type: "heading_4", heading_4: { rich_text: richText } };
    case "bulleted_list_item":
      return {
        block_id: blockId,
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: richText },
      };
    case "numbered_list_item":
      return {
        block_id: blockId,
        type: "numbered_list_item",
        numbered_list_item: { rich_text: richText },
      };
    case "quote":
      return { block_id: blockId, type: "quote", quote: { rich_text: richText } };
    case "toggle":
      return { block_id: blockId, type: "toggle", toggle: { rich_text: richText } };
    case "to_do":
      return { block_id: blockId, type: "to_do", to_do: { rich_text: richText } };
    case "callout":
      return { block_id: blockId, type: "callout", callout: { rich_text: richText } };
    case "template":
      return { block_id: blockId, type: "template", template: { rich_text: richText } };
    default:
      throw new Error(`Cannot update rich_text on unsupported block type "${type}".`);
  }
}

async function applyRichTextUpdate(
  notion: Client,
  blockId: string,
  type: string,
  richText: RichTextItemRequest[],
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  await notion.blocks.update(buildUpdateBody(blockId, type, richText));
}

async function upgradeParagraphToEquation(
  notion: Client,
  block: SourceBlock & { type: string; id: string },
  expression: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;

  const equationBlock: BlockObjectRequest = {
    object: "block",
    type: "equation",
    equation: { expression },
  };

  await notion.blocks.children.append({
    block_id: parentBlockId(block as unknown as Record<string, unknown>),
    children: [equationBlock],
    position: {
      type: "after_block",
      after_block: { id: block.id },
    },
  });
  await notion.blocks.delete({ block_id: block.id });
}

async function processTableRow(
  notion: Client,
  block: SourceBlock & { type: string; id: string },
  stats: Stats,
  dryRun: boolean,
): Promise<void> {
  const cells = getTableRowCells(block);
  if (!cells) return;

  let changed = false;
  const nextCells: RichTextItemRequest[][] = [];

  for (const cell of cells) {
    const rewritten = rewriteRichText(cell);
    stats.inlineConversions += rewritten.inlineConversions;
    stats.displayConversions += rewritten.displayConversions;
    stats.invalidSkipped += rewritten.invalidSkipped;
    stats.warnings.push(...rewritten.warnings);
    if (rewritten.changed) changed = true;
    nextCells.push(rewritten.items);
  }

  if (!changed) return;
  stats.blocksUpdated += 1;
  if (!dryRun) {
    await notion.blocks.update({
      block_id: block.id,
      type: "table_row",
      table_row: { cells: nextCells },
    });
  }
}

async function processChildren(
  notion: Client,
  parentId: string,
  stats: Stats,
  dryRun: boolean,
): Promise<void> {
  const children = await retrieveAllChildren(notion, parentId);
  for (const child of children) {
    await processBlock(notion, child, stats, dryRun);
  }
}

async function processBlock(
  notion: Client,
  block: SourceBlock,
  stats: Stats,
  dryRun: boolean,
): Promise<void> {
  if (!("type" in block) || !("id" in block)) return;
  if ("in_trash" in block && block.in_trash) return;

  const typed = block as SourceBlock & { type: string; id: string };

  if (typed.type === "table_row") {
    await processTableRow(notion, typed, stats, dryRun);
  } else if (typed.type !== "code" && RICH_TEXT_BLOCK_TYPES.has(typed.type)) {
    const richText = getBlockRichText(typed);
    if (richText) {
      const rewritten = rewriteRichText(richText);
      stats.inlineConversions += rewritten.inlineConversions;
      stats.displayConversions += rewritten.displayConversions;
      stats.invalidSkipped += rewritten.invalidSkipped;
      stats.warnings.push(...rewritten.warnings);

      const canUpgradeDisplay =
        typed.type === "paragraph" &&
        Boolean(rewritten.pureDisplayExpression) &&
        !("has_children" in typed && typed.has_children);

      if (canUpgradeDisplay && rewritten.pureDisplayExpression) {
        stats.blocksUpdated += 1;
        await upgradeParagraphToEquation(
          notion,
          typed,
          rewritten.pureDisplayExpression,
          dryRun,
        );
        return;
      }

      if (rewritten.changed) {
        stats.blocksUpdated += 1;
        await applyRichTextUpdate(
          notion,
          typed.id,
          typed.type,
          rewritten.items,
          dryRun,
        );
      }
    }
  }

  if (
    "has_children" in typed &&
    typed.has_children &&
    CONTAINER_TYPES.has(typed.type)
  ) {
    if (HEADING_TYPES.has(typed.type)) {
      const record = typed as unknown as Record<string, unknown>;
      if (!headingIsToggleable(record, typed.type)) {
        return;
      }
    }
    await processChildren(notion, typed.id, stats, dryRun);
  }
}

async function processHeadingSection(
  notion: Client,
  heading: SourceBlock & { type: string; id: string },
  stats: Stats,
  dryRun: boolean,
): Promise<void> {
  const level = headingLevel(heading.type);
  if (level === null) {
    throw new Error(`Expected a heading target, received "${heading.type}".`);
  }

  const parentId = parentBlockId(heading as unknown as Record<string, unknown>);
  const siblings = await retrieveAllChildren(notion, parentId);
  const startIndex = siblings.findIndex(
    (sibling) => "id" in sibling && sibling.id === heading.id,
  );
  if (startIndex === -1) {
    throw new Error("Could not find the target heading among its siblings.");
  }

  for (let index = startIndex; index < siblings.length; index += 1) {
    const sibling = siblings[index];
    if (!sibling || !("type" in sibling)) continue;

    if (index > startIndex) {
      const siblingLevel = headingLevel(sibling.type);
      if (siblingLevel !== null && siblingLevel <= level) break;
    }

    await processBlock(notion, sibling, stats, dryRun);
  }
}

function emptyStats(): Stats {
  return {
    blocksUpdated: 0,
    inlineConversions: 0,
    displayConversions: 0,
    invalidSkipped: 0,
    warnings: [],
  };
}

function printSummary(stats: Stats, dryRun: boolean): void {
  const verb = dryRun ? "Would update" : "Updated";
  console.log(
    `${verb} ${stats.blocksUpdated} blocks ` +
      `(${stats.inlineConversions} inline, ${stats.displayConversions} display). ` +
      `Skipped ${stats.invalidSkipped} invalid expression${stats.invalidSkipped === 1 ? "" : "s"}.`,
  );

  if (dryRun) {
    console.log("Nothing was sent to Notion.");
  }

  for (const warning of stats.warnings.slice(0, 10)) {
    console.warn(`Skipped invalid math: ${warning}`);
  }
  if (stats.warnings.length > 10) {
    console.warn(`…and ${stats.warnings.length - 10} more.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is missing. Add it to .env.");

  const notion = new Client({ auth: token });
  const targetId = normalizeNotionId(args.target);
  const stats = emptyStats();
  const dryRun = Boolean(args.dryRun);

  let target;
  try {
    target = await notion.blocks.retrieve({ block_id: targetId });
  } catch (blockError) {
    try {
      await notion.pages.retrieve({ page_id: targetId });
      await processChildren(notion, targetId, stats, dryRun);
      printSummary(stats, dryRun);
      return;
    } catch {
      throw blockError;
    }
  }

  if (!("type" in target) || !("id" in target)) {
    throw new Error("Notion returned a partial target block.");
  }

  const targetRecord = target as unknown as Record<string, unknown>;
  const isHeading = HEADING_TYPES.has(target.type);

  if (target.type === "child_page") {
    await processChildren(notion, target.id, stats, dryRun);
  } else if (
    target.type === "toggle" ||
    (isHeading && headingIsToggleable(targetRecord, target.type))
  ) {
    await processBlock(notion, target, stats, dryRun);
  } else if (isHeading) {
    await processHeadingSection(
      notion,
      target as SourceBlock & { type: string; id: string },
      stats,
      dryRun,
    );
  } else {
    throw new Error(
      `The --target link must point to a page, heading, or toggle; received "${target.type}".`,
    );
  }

  printSummary(stats, dryRun);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
