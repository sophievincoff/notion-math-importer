import "dotenv/config";

import { Client } from "@notionhq/client";
import type {
  BlockObjectRequest,
  ListBlockChildrenResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import process from "node:process";

type SourceBlock = ListBlockChildrenResponse["results"][number];

function usage(): never {
  console.error(`
Usage:
  npm run unpack -- --source CHILD_PAGE_URL_OR_ID --target TOGGLE_BLOCK_URL_OR_ID

Options:
  --source, -s   The child page whose contents should be copied.
  --target, -t   The destination toggle block.
  --help, -h     Show this help.

The source page is not changed or deleted.
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const result: { source?: string; target?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--source" || arg === "-s") {
      if (!value) usage();
      result.source = value;
      index += 1;
    } else if (arg === "--target" || arg === "-t") {
      if (!value) usage();
      result.target = value;
      index += 1;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!result.source || !result.target) usage();
  return result as { source: string; target: string };
}

function normalizeNotionId(input: string): string {
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

async function retrieveAllChildren(
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

const READ_ONLY_KEYS = new Set([
  "id",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "has_children",
  "archived",
  "in_trash",
  "parent",
  "request_id",
  "plain_text",
  "href",
]);

function cleanForRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanForRequest);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, child]) =>
          !READ_ONLY_KEYS.has(key) && child !== null && child !== undefined,
      )
      .map(([key, child]) => [key, cleanForRequest(child)]),
  );
}

function cloneableBlock(block: SourceBlock): BlockObjectRequest {
  if (!("type" in block)) {
    throw new Error("Notion returned a partial block that cannot be copied.");
  }

  const type = block.type;
  const unsupported = new Set([
    "unsupported",
    "child_page",
    "child_database",
    "link_preview",
    "meeting_notes",
  ]);
  if (unsupported.has(type)) {
    throw new Error(
      `The source contains a "${type}" block, which this unpacker cannot copy safely.`,
    );
  }

  const payload = cleanForRequest(
    (block as unknown as Record<string, unknown>)[type],
  );

  return {
    object: "block",
    type,
    [type]: payload,
  } as BlockObjectRequest;
}

async function copyChildren(
  notion: Client,
  sourceParentId: string,
  targetParentId: string,
): Promise<number> {
  const sourceBlocks = await retrieveAllChildren(notion, sourceParentId);
  let copied = 0;

  for (let offset = 0; offset < sourceBlocks.length; offset += 100) {
    const sourceBatch = sourceBlocks.slice(offset, offset + 100);
    const response = await notion.blocks.children.append({
      block_id: targetParentId,
      children: sourceBatch.map(cloneableBlock),
    });

    if (response.results.length !== sourceBatch.length) {
      throw new Error("Notion returned an unexpected number of copied blocks.");
    }

    copied += sourceBatch.length;

    for (let index = 0; index < sourceBatch.length; index += 1) {
      const source = sourceBatch[index];
      const destination = response.results[index];
      if (
        source &&
        destination &&
        "has_children" in source &&
        source.has_children &&
        "id" in destination
      ) {
        copied += await copyChildren(notion, source.id, destination.id);
      }
    }
  }

  return copied;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is missing. Add it to .env.");

  const sourceId = normalizeNotionId(args.source);
  const targetId = normalizeNotionId(args.target);
  if (sourceId === targetId) {
    throw new Error("The source page and target toggle cannot be the same block.");
  }

  const notion = new Client({ auth: token });
  const target = await notion.blocks.retrieve({ block_id: targetId });
  if (!("type" in target) || target.type !== "toggle") {
    throw new Error(
      `The target is a "${"type" in target ? target.type : "partial"}" block, not a toggle.`,
    );
  }

  const count = await copyChildren(notion, sourceId, targetId);
  console.log(`Copied ${count} blocks into the toggle.`);
  console.log("The original child page was left unchanged.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
