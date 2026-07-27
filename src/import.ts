import "dotenv/config";

import { Client } from "@notionhq/client";
import katex from "katex";
import type {
  BlockObjectRequest,
  CreatePageParameters,
  RichTextItemRequest,
} from "@notionhq/client/build/src/api-endpoints.js";
import type {
  Blockquote,
  Code,
  Content,
  Delete,
  Emphasis,
  Heading,
  Html,
  Image,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  Strong,
  Text,
  ThematicBreak,
} from "mdast";
import { readFile } from "node:fs/promises";
import process from "node:process";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

type InlineMath = PhrasingContent & { type: "inlineMath"; value: string };
type MathNode = Content & { type: "math"; value: string };
type NotionBlock = BlockObjectRequest;
type NotionRichText = RichTextItemRequest;

const MAX_BLOCKS_PER_REQUEST = 100;
const MAX_RICH_TEXT_CONTENT = 2_000;

function usage(): never {
  console.error(`
Usage:
  npm run import -- --input notes.md --title "My notes" [--parent PAGE_ID_OR_URL]
  cat notes.md | npm run import -- --target BLOCK_ID_OR_URL

Options:
  --input, -i    Markdown file. If omitted, Markdown is read from stdin.
  --title, -t    Title of the new Notion page.
  --parent, -p   Parent Notion page ID or URL. Defaults to NOTION_PARENT_PAGE_ID.
  --target       Append blocks directly to an existing Notion container.
  --dry-run      Parse and validate without creating a Notion page.
  --help, -h     Show this help.
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const result: {
    input?: string;
    title?: string;
    parent?: string;
    target?: string;
    dryRun?: boolean;
  } = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];

    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--input" || arg === "-i") {
      if (!value) usage();
      result.input = value;
      i += 1;
    } else if (arg === "--title" || arg === "-t") {
      if (!value) usage();
      result.title = value;
      i += 1;
    } else if (arg === "--parent" || arg === "-p") {
      if (!value) usage();
      result.parent = value;
      i += 1;
    } else if (arg === "--target") {
      if (!value) usage();
      result.target = value;
      i += 1;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return result;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) usage();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function normalizePageId(input: string): string {
  const matches = input.match(
    /[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/g,
  );
  const compact = (matches?.at(-1) ?? input).replaceAll("-", "");

  if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
    throw new Error("The parent must be a Notion page URL or a 32-character page ID.");
  }

  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function normalizeChatMath(markdown: string): string {
  // remark-math understands $...$ and $$...$$. Chat responses often use
  // \(...\) and \[...\], so normalize those forms outside fenced code.
  const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) =>
          `\n\n$$\n${expression.trim()}\n$$\n\n`,
        )
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) =>
          `$${expression.trim()}$`,
        );
    })
    .join("");
}

function validateEquation(expression: string): string {
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

function annotations(overrides: Partial<NonNullable<NotionRichText["annotations"]>> = {}) {
  return {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default" as const,
    ...overrides,
  };
}

function textItems(
  content: string,
  marks: Partial<NonNullable<NotionRichText["annotations"]>> = {},
  href?: string,
): NotionRichText[] {
  if (!content) return [];
  const chunks = content.match(new RegExp(`[\\s\\S]{1,${MAX_RICH_TEXT_CONTENT}}`, "g")) ?? [];
  return chunks.map((chunk) => ({
    type: "text",
    text: {
      content: chunk,
      link: href ? { url: href } : null,
    },
    annotations: annotations(marks),
  }));
}

function inlineToRichText(
  nodes: PhrasingContent[],
  inherited: Partial<NonNullable<NotionRichText["annotations"]>> = {},
  href?: string,
): NotionRichText[] {
  const output: NotionRichText[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        output.push(...textItems((node as Text).value, inherited, href));
        break;
      case "inlineMath":
        output.push({
          type: "equation",
          equation: { expression: validateEquation((node as InlineMath).value) },
          annotations: annotations(inherited),
        });
        break;
      case "inlineCode":
        output.push(
          ...textItems((node as InlineCode).value, { ...inherited, code: true }, href),
        );
        break;
      case "strong":
        output.push(
          ...inlineToRichText(
            (node as Strong).children,
            { ...inherited, bold: true },
            href,
          ),
        );
        break;
      case "emphasis":
        output.push(
          ...inlineToRichText(
            (node as Emphasis).children,
            { ...inherited, italic: true },
            href,
          ),
        );
        break;
      case "delete":
        output.push(
          ...inlineToRichText(
            (node as Delete).children,
            { ...inherited, strikethrough: true },
            href,
          ),
        );
        break;
      case "link": {
        const link = node as Link;
        output.push(...inlineToRichText(link.children, inherited, link.url));
        break;
      }
      case "break":
        output.push(...textItems("\n", inherited, href));
        break;
      case "image": {
        const image = node as Image;
        output.push(...textItems(image.alt ? `[Image: ${image.alt}]` : image.url, inherited));
        break;
      }
      case "html":
        output.push(...textItems((node as Html).value, inherited, href));
        break;
      default:
        output.push(...textItems("value" in node ? String(node.value) : "", inherited, href));
    }
  }

  return output;
}

function paragraphBlock(node: Paragraph): NotionBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: inlineToRichText(node.children),
      color: "default",
    },
  };
}

function headingBlock(node: Heading): NotionBlock {
  const richText = inlineToRichText(node.children);
  if (node.depth === 1) {
    return { object: "block", type: "heading_1", heading_1: { rich_text: richText } };
  }
  if (node.depth === 2) {
    return { object: "block", type: "heading_2", heading_2: { rich_text: richText } };
  }
  return { object: "block", type: "heading_3", heading_3: { rich_text: richText } };
}

function codeBlock(node: Code): NotionBlock {
  return {
    object: "block",
    type: "code",
    code: {
      rich_text: textItems(node.value),
      language: notionLanguage(node.lang),
    },
  };
}

function notionLanguage(language?: string | null): "plain text" | "javascript" | "typescript" | "python" | "json" | "bash" | "markdown" | "latex" {
  const normalized = language?.toLowerCase();
  if (normalized === "js" || normalized === "javascript") return "javascript";
  if (normalized === "ts" || normalized === "typescript") return "typescript";
  if (normalized === "py" || normalized === "python") return "python";
  if (normalized === "json") return "json";
  if (normalized === "sh" || normalized === "shell" || normalized === "bash") return "bash";
  if (normalized === "md" || normalized === "markdown") return "markdown";
  if (normalized === "tex" || normalized === "latex") return "latex";
  return "plain text";
}

function listItemBlock(node: ListItem, ordered: boolean): NotionBlock {
  const firstParagraph = node.children.find((child): child is Paragraph => child.type === "paragraph");
  const nestedBlocks = node.children
    .filter((child) => child !== firstParagraph)
    .flatMap(contentToBlocks);
  const richText = firstParagraph ? inlineToRichText(firstParagraph.children) : [];

  if (ordered) {
    return {
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: {
        rich_text: richText,
        ...(nestedBlocks.length ? { children: nestedBlocks as never } : {}),
      },
    };
  }

  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: richText,
      ...(nestedBlocks.length ? { children: nestedBlocks as never } : {}),
    },
  };
}

function contentToBlocks(node: Content): NotionBlock[] {
  switch (node.type) {
    case "paragraph":
      return [paragraphBlock(node as Paragraph)];
    case "heading":
      return [headingBlock(node as Heading)];
    case "code":
      return [codeBlock(node as Code)];
    case "math":
      return [{
        object: "block",
        type: "equation",
        equation: { expression: validateEquation((node as MathNode).value) },
      }];
    case "thematicBreak":
      return [{ object: "block", type: "divider", divider: {} }];
    case "blockquote": {
      const quote = node as Blockquote;
      const richText = quote.children
        .filter((child): child is Paragraph => child.type === "paragraph")
        .flatMap((child, index) => [
          ...(index ? textItems("\n") : []),
          ...inlineToRichText(child.children),
        ]);
      return [{
        object: "block",
        type: "quote",
        quote: { rich_text: richText },
      }];
    }
    case "list": {
      const list = node as List;
      return list.children.map((item) => listItemBlock(item, Boolean(list.ordered)));
    }
    case "html":
      return [{
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: textItems((node as Html).value) },
      }];
    default:
      return [];
  }
}

function documentToBlocks(root: Root): NotionBlock[] {
  return root.children.flatMap(contentToBlocks);
}

async function appendInBatches(
  notion: Client,
  pageId: string,
  blocks: NotionBlock[],
): Promise<void> {
  for (let offset = 0; offset < blocks.length; offset += MAX_BLOCKS_PER_REQUEST) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(offset, offset + MAX_BLOCKS_PER_REQUEST),
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const title = args.title ?? "Imported ChatGPT notes";

  const markdown = args.input
    ? await readFile(args.input, "utf8")
    : await readStdin();

  const normalized = normalizeChatMath(markdown);
  const tree = unified().use(remarkParse).use(remarkMath).parse(normalized) as Root;
  const blocks = documentToBlocks(tree);

  if (args.dryRun) {
    console.log(`Validated ${blocks.length} blocks. Nothing was sent to Notion.`);
    return;
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is missing. Add it to .env.");
  const notion = new Client({ auth: token });

  if (args.target) {
    if (args.parent) {
      throw new Error("Use either --target or --parent, not both.");
    }
    const targetId = normalizePageId(args.target);
    await appendInBatches(notion, targetId, blocks);
    console.log(`Appended ${blocks.length} blocks directly to the target.`);
    return;
  }

  const parentInput = args.parent ?? process.env.NOTION_PARENT_PAGE_ID;
  if (!parentInput) {
    throw new Error(
      "No parent page supplied. Set NOTION_PARENT_PAGE_ID or use --parent.",
    );
  }

  const parentPageId = normalizePageId(parentInput);

  const pageRequest: CreatePageParameters = {
    parent: { type: "page_id", page_id: parentPageId },
    properties: {
      title: {
        type: "title",
        title: textItems(title),
      },
    },
  };

  const page = await notion.pages.create(pageRequest);
  await appendInBatches(notion, page.id, blocks);

  console.log(`Imported ${blocks.length} blocks.`);
  console.log(`https://www.notion.so/${page.id.replaceAll("-", "")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
