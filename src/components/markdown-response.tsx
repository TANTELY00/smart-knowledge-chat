import { createElement, type ReactNode } from "react";

type ListMarker = {
  indent: number;
  ordered: boolean;
  content: string;
};

function getListMarker(line: string): ListMarker | null {
  const match = line.match(/^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/);
  if (!match) return null;

  const [indentation, marker, content] = match.slice(1);
  if (indentation === undefined || marker === undefined || content === undefined) return null;

  return {
    indent: indentation.replace(/\t/g, "    ").length,
    ordered: /^\d/.test(marker),
    content,
  };
}

function renderInline(text: string): ReactNode[] {
  const tokens =
    /(\*\*.+?\*\*|__.+?__|`[^`]+`|\$\s*\\rightarrow\s*\$|\\rightarrow|\[[^\]\n]+\]|\*(?!\s).+?\*|_(?!\s).+?_)/g;

  return text
    .split(tokens)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**") || part.startsWith("__")) {
        return (
          <strong key={index} className="font-semibold text-foreground">
            {renderInline(part.slice(2, -2))}
          </strong>
        );
      }
      if (part.startsWith("`")) {
        return (
          <code key={index} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]">
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith("*") || part.startsWith("_")) {
        return <em key={index}>{renderInline(part.slice(1, -1))}</em>;
      }
      if (part.startsWith("[") && part.endsWith("]")) {
        return (
          <span
            key={index}
            className="rounded bg-secondary px-1 py-0.5 text-xs font-medium text-secondary-foreground"
          >
            {part}
          </span>
        );
      }

      return <span key={index}>{part.replace(/\$\s*\\rightarrow\s*\$|\\rightarrow/g, "→")}</span>;
    });
}

function renderList(lines: string[], start: number): [ReactNode, number] {
  const firstLine = lines[start];
  const first = firstLine === undefined ? null : getListMarker(firstLine);
  if (!first) return [null, start];

  const items: ReactNode[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const marker = getListMarker(line);
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;

    const content = marker.content;
    const nestedLines: string[] = [];
    index++;

    while (index < lines.length) {
      const nestedLine = lines[index];
      if (nestedLine === undefined) break;
      if (!nestedLine.trim()) {
        let next = index + 1;
        while (next < lines.length) {
          const nextLine = lines[next];
          if (nextLine === undefined || nextLine.trim()) break;
          next++;
        }
        const nextLine = lines[next];
        const nextMarker = nextLine === undefined ? null : getListMarker(nextLine);
        if (nextMarker && nextMarker.indent >= first.indent) {
          index = next;
          continue;
        }
        break;
      }

      const nextMarker = getListMarker(nestedLine);
      if (nextMarker && nextMarker.indent <= first.indent) break;

      if ((nextMarker && nextMarker.indent > first.indent) || /^\s+/.test(nestedLine)) {
        nestedLines.push(nestedLine.trimStart());
        index++;
        continue;
      }
      break;
    }

    items.push(
      <li key={items.length} className="pl-1">
        {renderInline(content)}
        {nestedLines.length > 0 && renderBlocks(nestedLines)}
      </li>,
    );
  }

  const className = "list-inside space-y-2 pl-5 marker:text-primary";
  return [
    first.ordered ? (
      <ol key={start} className={`list-decimal ${className}`}>
        {items}
      </ol>
    ) : (
      <ul key={start} className={`list-disc ${className}`}>
        {items}
      </ul>
    ),
    index,
  ];
}

function renderBlocks(content: string[]): ReactNode[] {
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < content.length) {
    const currentLine = content[index];
    if (currentLine === undefined) break;
    const line = currentLine.trim();
    if (!line) {
      index++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const [, marks, title] = heading;
      if (marks === undefined || title === undefined) break;
      const level = marks.length;
      const classes = {
        1: "text-2xl font-bold",
        2: "text-xl font-semibold",
        3: "text-lg font-semibold",
        4: "text-base font-semibold",
        5: "text-sm font-semibold",
        6: "text-sm font-medium",
      }[level];
      blocks.push(
        createElement(
          `h${level}`,
          { key: index, className: `font-display tracking-tight ${classes}` },
          renderInline(title),
        ),
      );
      index++;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push(<hr key={index} className="border-border" />);
      index++;
      continue;
    }

    if (/^\s*>/.test(currentLine)) {
      const quote: string[] = [];
      while (index < content.length) {
        const quoteLine = content[index];
        if (quoteLine === undefined || !/^\s*>/.test(quoteLine)) break;
        quote.push(quoteLine.replace(/^\s*>\s?/, "").trim());
        index++;
      }
      blocks.push(
        <blockquote key={index} className="border-l-2 border-primary/40 pl-4 text-muted-foreground">
          {renderInline(quote.join(" "))}
        </blockquote>,
      );
      continue;
    }

    if (getListMarker(currentLine)) {
      const [list, next] = renderList(content, index);
      blocks.push(list);
      index = next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < content.length) {
      const paragraphLine = content[index];
      if (paragraphLine === undefined || !paragraphLine.trim()) break;
      if (
        paragraph.length > 0 &&
        (/^(#{1,6})\s+/.test(paragraphLine) ||
          getListMarker(paragraphLine) ||
          /^\s*>/.test(paragraphLine))
      ) {
        break;
      }
      paragraph.push(paragraphLine.trim());
      index++;
    }
    blocks.push(<p key={index}>{renderInline(paragraph.join(" "))}</p>);
  }

  return blocks;
}

export function MarkdownResponse({ content }: { content: string }) {
  return (
    <div className="space-y-3 break-words text-sm leading-7">
      {renderBlocks(content.replace(/\r/g, "").split("\n"))}
    </div>
  );
}
