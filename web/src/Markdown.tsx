import type { ReactNode } from 'react';

// Rendu Markdown minimal des rapports de council, sans dépendance ni HTML brut : titres, listes
// (imbriquées par indentation), citations, tableaux, blocs de code, gras, italique, code et liens http(s).

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])|(?<!\w)_(?!\s)([^_]+?)_(?!\w)/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index;
    if (index > last) nodes.push(text.slice(last, index));
    const [, code, bold, boldAlt, label, url, italic, italicAlt] = match;
    const key = nodes.length;
    if (code !== undefined) nodes.push(<code key={key}>{code}</code>);
    else if (bold !== undefined || boldAlt !== undefined) nodes.push(<strong key={key}>{inline(bold ?? boldAlt!)}</strong>);
    else if (label !== undefined) nodes.push(<a key={key} href={url} target="_blank" rel="noreferrer">{inline(label)}</a>);
    else nodes.push(<em key={key}>{inline(italic ?? italicAlt!)}</em>);
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
  return FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || QUOTE.test(line) || TABLE_ROW.test(line) || RULE.test(line);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

interface ListItem {
  text: string;
  children: string[];
}

function list(lines: string[], start: number, key: number): [ReactNode, number] {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    const item = LIST_ITEM.exec(line);
    if (item !== null && item[1]!.length <= indent) {
      if (/\d/.test(item[2]!) !== ordered) break;
      items.push({ text: item[3]!, children: [] });
    } else if (line.trim() === '') {
      // Une ligne vide ne termine la liste que si la suivante n'en fait plus partie.
      const next = lines[index + 1];
      if (next === undefined || indentOf(next) <= indent && !LIST_ITEM.test(next)) break;
      items.at(-1)!.children.push('');
    } else if (indentOf(line) > indent) {
      items.at(-1)!.children.push(line);
    } else {
      break;
    }
    index++;
  }
  const Tag = ordered ? 'ol' : 'ul';
  const startAt = ordered ? Number.parseInt(first[2]!, 10) : undefined;
  return [
    <Tag key={key} start={startAt !== 1 ? startAt : undefined}>
      {items.map((item, itemIndex) => {
        const children = item.children.filter((line) => line.trim() !== '');
        // Lignes sans puce avant la sous-liste : suite du texte de l'élément.
        const firstNested = children.findIndex((line) => LIST_ITEM.test(line));
        const split = firstNested === -1 ? children.length : firstNested;
        const text = [item.text, ...children.slice(0, split).map((line) => line.trim())].join(' ');
        const nested = children.slice(split);
        return <li key={itemIndex}>{inline(text)}{nested.length > 0 ? blocks(dedent(nested)) : null}</li>;
      })}
    </Tag>,
    index,
  ];
}

function dedent(lines: string[]): string[] {
  const indent = Math.min(...lines.filter((line) => line.trim() !== '').map(indentOf));
  return lines.map((line) => line.slice(Math.min(indent, indentOf(line))));
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function blocks(lines: string[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const key = nodes.length;
    if (line.trim() === '') {
      index++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(fence[1]!)) body.push(lines[index++]!);
      index++;
      nodes.push(<pre key={key}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      // Les titres restent sous ceux du rapport : # devient un h3.
      const Tag = `h${Math.min(6, heading[1]!.length + 2)}` as 'h3';
      nodes.push(<Tag key={key}>{inline(heading[2]!)}</Tag>);
      index++;
      continue;
    }
    if (RULE.test(line)) {
      nodes.push(<hr key={key}/>);
      index++;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [node, next] = list(lines, index, key);
      nodes.push(node);
      index = next;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) body.push(lines[index++]!.replace(QUOTE, ''));
      nodes.push(<blockquote key={key}>{blocks(body)}</blockquote>);
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index]!)) rows.push(cells(lines[index++]!));
      nodes.push(<div key={key} className="md-table"><table>
        <thead><tr>{head.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody>
      </table></div>);
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index++;
    while (index < lines.length && lines[index]!.trim() !== '' && !startsBlock(lines[index]!)) paragraph.push(lines[index++]!.trim());
    nodes.push(<p key={key}>{inline(paragraph.join(' '))}</p>);
  }
  return nodes;
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`md ${className}`.trim()}>{blocks(text.replace(/\r\n?/g, '\n').split('\n'))}</div>;
}
