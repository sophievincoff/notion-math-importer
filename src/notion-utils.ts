import { Client } from "@notionhq/client";
import katex from "katex";
import type { ListBlockChildrenResponse } from "@notionhq/client/build/src/api-endpoints.js";

export type SourceBlock = ListBlockChildrenResponse["results"][number];

export const HEADING_TYPES = new Set([
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
]);

export function normalizeNotionId(input: string): string {
  const matches = input.match(
    /[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/g,
  );
  const compact = (matches?.at(-1) ?? input).replaceAll("-", "");

  if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
    throw new Error(
      "Expected a Notion page/block URL or a 32-character Notion ID.",
    );
  }

  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

export function validateEquation(expression: string): string {
  try {
    katex.renderToString(expression, {
      throwOnError: true,
      strict: "warn",
      output: "html",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid KaTeX expression:\n${expression}\n\n${detail}`);
  }
  return expression;
}

export function tryValidateEquation(expression: string): boolean {
  try {
    validateEquation(expression);
    return true;
  } catch {
    return false;
  }
}

export function headingIsToggleable(
  block: Record<string, unknown>,
  type: string,
): boolean {
  const payload = block[type];
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "is_toggleable" in payload &&
      payload.is_toggleable,
  );
}

export function parentBlockId(block: Record<string, unknown>): string {
  const parent = block.parent;
  if (!parent || typeof parent !== "object" || !("type" in parent)) {
    throw new Error("Could not determine the heading's parent container.");
  }
  if (parent.type === "page_id" && "page_id" in parent) return String(parent.page_id);
  if (parent.type === "block_id" && "block_id" in parent) return String(parent.block_id);
  throw new Error("This heading's parent is not a writable page or block.");
}

export function headingLevel(type: string): number | null {
  switch (type) {
    case "heading_1":
      return 1;
    case "heading_2":
      return 2;
    case "heading_3":
      return 3;
    case "heading_4":
      return 4;
    default:
      return null;
  }
}

export async function retrieveAllChildren(
  notion: Client,
  blockId: string,
): Promise<SourceBlock[]> {
  const blocks: SourceBlock[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    blocks.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return blocks;
}
