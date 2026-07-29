# Kitchen-sink import prompt

This prompt asks ChatGPT to produce a broad Markdown sample for manually
testing the Notion importer. The captured response is stored in
[`kitchen-sink.md`](kitchen-sink.md).

## Prompt

Write a self-contained mini technical tutorial about designing a fictional Mars greenhouse monitoring system.

This response is specifically for testing a Markdown-to-Notion importer. Purposefully include every item below, using valid Markdown:

1. A level-1 title and examples of level-2 and level-3 headings.
2. Several normal paragraphs.
3. Bold, italic, bold-italic, strikethrough, and inline code formatting.
4. A hyperlink with descriptive link text.
5. An inline equation using `\( ... \)`.
6. A display equation using `\[ ... \]`.
7. Another inline equation using `$...$` and another display equation using `$$...$$`.
8. A bulleted list with a nested bulleted list.
9. A numbered list with a nested numbered list.
10. A blockquote containing multiple sentences.
11. A horizontal divider.
12. A fenced Python code block containing a small working function.
13. A fenced JSON code block containing a configuration object.
14. A fenced Bash code block.
15. A Markdown table with at least four columns and five body rows. Inside its cells, include:
    - bold text,
    - italic text,
    - inline code,
    - a hyperlink,
    - inline math,
    - an empty cell,
    - and text containing punctuation.
16. A second table with deliberately uneven text lengths.
17. A task list with checked and unchecked items.
18. A raw URL that should become an automatic link.
19. Special characters such as `<`, `>`, `&`, quotes, em dashes, Greek letters, and emoji.
20. A final “Expected takeaways” section.

Make the content coherent and useful, not merely a list of formatting demonstrations. Do not wrap the entire response in one code fence. Ensure every Markdown table has a header separator row and a blank line before and after it.
