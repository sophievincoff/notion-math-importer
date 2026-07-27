# Notion Math Importer

Import Markdown from ChatGPT into Notion while preserving native inline and
display equations.

The importer creates a new child page beneath a Notion page you choose. It
supports headings, paragraphs, emphasis, links, inline code, fenced code,
lists, quotes, dividers, inline math, and display math.

## 1. Create a Notion integration

1. Open <https://www.notion.so/profile/integrations>.
2. Create a new internal integration.
3. Give it **Read content** and **Insert content** capabilities.
4. Copy its internal integration token.

## 2. Share a destination page

Open the Notion page that should contain your imported notes. Open its
connections menu and connect the integration you created.

The importer can only access pages explicitly shared with the integration.

## 3. Install and configure

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```dotenv
NOTION_TOKEN=secret_your_internal_integration_token
NOTION_PARENT_PAGE_ID=https://www.notion.so/Your-Page-0123456789abcdef0123456789abcdef
```

Keep `.env` private. It is excluded from Git.

## 4. Import Markdown

From a file:

```bash
npm run import -- --input example.md --title "Generator Matching Notes"
```

Or from the clipboard on macOS:

```bash
pbpaste | npm run import -- --title "Imported ChatGPT Answer"
```

The command prints the URL of the newly created Notion page.

To append clipboard contents directly to an existing toggle or other container,
copy that block's link in Notion and run:

```bash
pbpaste | npm run import -- --target "NOTION_BLOCK_LINK"
```

With `--target`, no child page is created and `--title` is not needed.

Test parsing and equations without contacting Notion:

```bash
npm run import -- --input example.md --dry-run
```

You can override the configured parent page:

```bash
npm run import -- \
  --input notes.md \
  --title "Research Notes" \
  --parent "NOTION_PAGE_URL_OR_ID"
```

## Unpack a child page into a toggle

In Notion, open the child page's menu and choose **Copy link**. Then open the
toggle block's menu and choose **Copy link to block**.

Run:

```bash
npm run unpack -- \
  --source "CHILD_PAGE_LINK" \
  --target "TOGGLE_BLOCK_LINK"
```

The command recursively copies the child page's contents into the toggle. It
leaves the original child page unchanged so you can verify the result before
deleting it manually.

## Math formats

All common ChatGPT math delimiters are accepted:

```text
$inline$
$$display$$
\(inline\)
\[display\]
```

Equations are validated with KaTeX before anything is written. If an equation
is invalid, the import stops and reports the expression so it can be corrected.

## Safety

- The tool creates a new child page; it does not rewrite existing page content.
- The Notion token remains in your local `.env`.
- No language model or third-party conversion service receives the notes.
