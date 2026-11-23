import type { ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown.ts";

/**
 * Model output drawn with the small markdown subset of `markdown.ts`. Every node of the tree becomes a React element
 * or a React text child: no HTML string is built, and the tree has no node that could become a link, an image or any
 * element the text names. Only an agent's reply and a review come here; text a person or an outside source wrote (a
 * prompt, a GitHub issue, another workbench) stays plain text.
 */
export function MarkdownView({ text, className, testId }: { text: string; className: string; testId?: string }) {
  return (
    <div data-ds-content="" data-testid={testId} className={className}>
      {parseMarkdown(text).map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return <p>{inline(block.children)}</p>;
    case "code":
      return (
        <figure className="ds-code-block">
          <pre className="ds-code-block__body">
            <code>{block.text}</code>
          </pre>
        </figure>
      );
    case "list": {
      const rows = block.items.map((item, i) => (
        <li key={i} className="ds-list__row">
          <div className="ds-list__content">
            <span className="ds-list__body">
              <span>
                {item.marker}
                {inline(item.children)}
              </span>
            </span>
          </div>
        </li>
      ));
      // A list row draws no bullet or number of its own, so each item shows its marker: a bullet, or its own number.
      return block.ordered ? <ol className="ds-list ds-list--dense">{rows}</ol> : <ul className="ds-list ds-list--dense">{rows}</ul>;
    }
  }
}

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "code":
        return <code key={i}>{node.text}</code>;
      case "strong":
        return <strong key={i}>{inline(node.children)}</strong>;
      case "em":
        return <em key={i}>{inline(node.children)}</em>;
    }
  });
}
