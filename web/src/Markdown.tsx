import type { ReactNode } from 'react';

// Rendu Markdown minimal des rapports de council, sans dépendance ni HTML brut : titres, listes
// (imbriquées par indentation), citations, tableaux, blocs de code, gras, italique, code et liens http(s).
// With `sourceLines`, every rendered block carries the source lines it comes from (`data-line`, and
// `data-line-end` when it spans several), for the « Fichiers » panel of the session view.
// [SPEC: Interface › Vue session desktop, panneau « Fichiers »]

const INLINE =
  /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])|(?<!\w)_(?!\s)([^_]+?)_(?!\w)/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index;
    if (index > last) nodes.push(text.slice(last, index));
    const [, code, bold, boldAlt, label, url, italic, italicAlt] = match;
    const key = nodes.length;
    if (code !== undefined) nodes.push(<code key={key}>{code}</code>);
    else if (bold !== undefined || boldAlt !== undefined)
      nodes.push(<strong key={key}>{inline(bold ?? boldAlt)}</strong>);
    else if (label !== undefined)
      nodes.push(
        <a key={key} href={url} target="_blank" rel="noreferrer">
          {inline(label)}
        </a>,
      );
    else nodes.push(<em key={key}>{inline(italic ?? italicAlt)}</em>);
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    LIST_ITEM.test(line) ||
    QUOTE.test(line) ||
    TABLE_ROW.test(line) ||
    RULE.test(line)
  );
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A source line and its 1-based number in the rendered text. */
interface Line {
  text: string;
  n: number;
}

interface Options {
  sourceLines: boolean;
  headingShift: number;
}

type LineAttributes = { 'data-line'?: number; 'data-line-end'?: number };

function at(options: Options, start: number, end = start): LineAttributes {
  if (!options.sourceLines) return {};
  return end > start ? { 'data-line': start, 'data-line-end': end } : { 'data-line': start };
}

interface ListItem {
  text: string;
  n: number;
  children: Line[];
}

function list(lines: Line[], start: number, key: number, options: Options): [ReactNode, number] {
  const first = LIST_ITEM.exec(lines[start].text)!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    const item = LIST_ITEM.exec(line.text);
    if (item !== null && item[1].length <= indent) {
      if (/\d/.test(item[2]) !== ordered) break;
      items.push({ text: item[3], n: line.n, children: [] });
    } else if (line.text.trim() === '') {
      // Une ligne vide ne termine la liste que si la suivante n'en fait plus partie.
      const next = lines[index + 1];
      if (next === undefined || (indentOf(next.text) <= indent && !LIST_ITEM.test(next.text))) break;
      items.at(-1)!.children.push(line);
    } else if (indentOf(line.text) > indent) {
      items.at(-1)!.children.push(line);
    } else {
      break;
    }
    index++;
  }
  const Tag = ordered ? 'ol' : 'ul';
  const startAt = ordered ? Number.parseInt(first[2], 10) : undefined;
  return [
    <Tag key={key} start={startAt !== 1 ? startAt : undefined}>
      {items.map((item, itemIndex) => {
        const children = item.children.filter((line) => line.text.trim() !== '');
        // Lignes sans puce avant la sous-liste : suite du texte de l'élément.
        const firstNested = children.findIndex((line) => LIST_ITEM.test(line.text));
        const split = firstNested === -1 ? children.length : firstNested;
        const continued = children.slice(0, split);
        const text = [item.text, ...continued.map((line) => line.text.trim())].join(' ');
        const nested = children.slice(split);
        return (
          <li key={itemIndex} {...at(options, item.n, continued.at(-1)?.n ?? item.n)}>
            {inline(text)}
            {nested.length > 0 ? blocks(dedent(nested), options) : null}
          </li>
        );
      })}
    </Tag>,
    index,
  ];
}

function dedent(lines: Line[]): Line[] {
  const indent = Math.min(...lines.filter((line) => line.text.trim() !== '').map((line) => indentOf(line.text)));
  return lines.map((line) => ({ ...line, text: line.text.slice(Math.min(indent, indentOf(line.text))) }));
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function codeBody(body: Line[], options: Options): ReactNode {
  if (!options.sourceLines) return body.map((line) => line.text).join('\n');
  return body.map((line, index) => (
    <span key={index} data-line={line.n}>
      {index < body.length - 1 ? `${line.text}\n` : line.text}
    </span>
  ));
}

function blocks(lines: Line[], options: Options): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].text;
    const first = lines[index].n;
    const key = nodes.length;
    if (line.trim() === '') {
      index++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body: Line[] = [];
      index++;
      while (index < lines.length && !lines[index].text.trimStart().startsWith(fence[1])) body.push(lines[index++]);
      const last = (lines[index] ?? body.at(-1) ?? lines[index - 1]).n;
      index++;
      nodes.push(
        <pre key={key} {...at(options, first, last)}>
          <code>{codeBody(body, options)}</code>
        </pre>,
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      // Les rapports de council gardent leurs titres sous les leurs : # devient un h3.
      const Tag = `h${Math.min(6, heading[1].length + options.headingShift)}` as 'h3';
      nodes.push(
        <Tag key={key} {...at(options, first)}>
          {inline(heading[2])}
        </Tag>,
      );
      index++;
      continue;
    }
    if (RULE.test(line)) {
      nodes.push(<hr key={key} {...at(options, first)} />);
      index++;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [node, next] = list(lines, index, key, options);
      nodes.push(node);
      index = next;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: Line[] = [];
      while (index < lines.length && QUOTE.test(lines[index].text)) {
        const quoted = lines[index++];
        body.push({ ...quoted, text: quoted.text.replace(QUOTE, '') });
      }
      nodes.push(<blockquote key={key}>{blocks(body, options)}</blockquote>);
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1]?.text ?? '')) {
      const head = cells(line);
      const rows: Line[] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index].text)) rows.push(lines[index++]);
      nodes.push(
        <div key={key} className="md-table" {...at(options, first, rows.at(-1)?.n ?? first + 1)}>
          <table>
            <thead>
              <tr {...at(options, first)}>
                {head.map((cell, cellIndex) => (
                  <th key={cellIndex}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} {...at(options, row.n)}>
                  {cells(row.text).map((cell, cellIndex) => (
                    <td key={cellIndex}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const paragraph: string[] = [line.trim()];
    let last = first;
    index++;
    while (index < lines.length && lines[index].text.trim() !== '' && !startsBlock(lines[index].text)) {
      last = lines[index].n;
      paragraph.push(lines[index++].text.trim());
    }
    nodes.push(
      <p key={key} {...at(options, first, last)}>
        {inline(paragraph.join(' '))}
      </p>,
    );
  }
  return nodes;
}

export function Markdown({
  text,
  className = '',
  sourceLines = false,
  headingShift = 2,
}: {
  text: string;
  className?: string;
  /** Tag each block with its source line numbers (`data-line`, `data-line-end`). */
  sourceLines?: boolean;
  /** Added to the heading level: 2 by default, so that `#` becomes an h3 under the page's own titles. */
  headingShift?: number;
}) {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line, index) => ({ text: line, n: index + 1 }));
  return <div className={`md ${className}`.trim()}>{blocks(lines, { sourceLines, headingShift })}</div>;
}
