import type { Definition, Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

export type TelegramEntity = {
  type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'pre' | 'text_link';
  offset: number;
  length: number;
  url?: string;
  language?: string;
};

export type TelegramFormattedChunk = { text: string; entities?: TelegramEntity[] };
const parser = unified().use(remarkParse).use(remarkGfm);
const redact = (text: string, token: string | null) =>
  token ? text.replaceAll(token, '[redacted]') : text;

/** Render CommonMark/GFM to Telegram entities, without interpreting model HTML or MarkdownV2. */
export function telegramMarkdown(source: string, token: string | null): TelegramFormattedChunk {
  const clean = redact(source, token);
  try {
    const root = parser.parse(clean);
    const definitions = new Map<string, Definition>();
    const collect = (node: Nodes) => {
      if (node.type === 'definition' && !definitions.has(node.identifier))
        definitions.set(node.identifier, node);
      if ('children' in node) node.children.forEach(collect);
    };
    collect(root);
    let text = '';
    const entities: TelegramEntity[] = [];
    // Redact again after Markdown entity/escape decoding, before calculating offsets.
    const append = (value: string) => {
      text += redact(value, token);
    };
    const span = (
      type: TelegramEntity['type'],
      render: () => void,
      extra: Partial<TelegramEntity> = {},
    ) => {
      const offset = text.length;
      render();
      if (text.length > offset)
        entities.push({ ...extra, type, offset, length: text.length - offset });
    };
    let insideLink = false;
    const link = (url: string | undefined, render: () => void) => {
      let safe = false;
      try {
        const parsed = new URL(url!);
        safe =
          ['https:', 'http:', 'mailto:'].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password &&
          !/[\u0000-\u0020\u007f]/.test(url!) &&
          !url!.includes('[redacted]') &&
          !decodeURIComponent(url!).includes('[redacted]') &&
          !(token && decodeURIComponent(url!).includes(token));
      } catch {
        /* Local paths and malformed URLs remain readable labels. */
      }
      if (safe && !insideLink) {
        insideLink = true;
        span('text_link', render, { url: url! });
        insideLink = false;
      } else render();
    };
    const children = (nodes: Nodes[], separator = '', depth = 0) => {
      const visible = nodes.filter((node) => node.type !== 'definition');
      visible.forEach((node, index) => {
        if (index) append(separator);
        render(node, depth);
      });
    };
    const render = (node: Nodes, depth = 0): void => {
      switch (node.type) {
        case 'root':
          children(node.children, '\n\n', depth);
          break;
        case 'paragraph':
          children(node.children, '', depth);
          break;
        case 'text':
        case 'html':
          append(node.value);
          break;
        case 'break':
          append('\n');
          break;
        case 'heading':
          span('bold', () => children(node.children, '', depth));
          break;
        case 'strong':
          span('bold', () => children(node.children, '', depth));
          break;
        case 'emphasis':
          span('italic', () => children(node.children, '', depth));
          break;
        case 'delete':
          span('strikethrough', () => children(node.children, '', depth));
          break;
        case 'inlineCode':
          span('code', () => append(node.value));
          break;
        case 'code':
          span(
            'pre',
            () => append(node.value),
            node.lang && /^[\w+-]{1,40}$/.test(node.lang) && !(token && node.lang.includes(token))
              ? { language: node.lang }
              : {},
          );
          break;
        case 'link':
          link(node.url, () => children(node.children, '', depth));
          break;
        case 'linkReference':
          link(definitions.get(node.identifier)?.url, () => children(node.children, '', depth));
          break;
        case 'image':
          link(node.url, () => append(node.alt || '이미지'));
          break;
        case 'imageReference':
          link(definitions.get(node.identifier)?.url, () => append(node.alt || '이미지'));
          break;
        case 'footnoteReference':
          append(`[${node.label ?? node.identifier}]`);
          break;
        case 'footnoteDefinition':
          append(`[${node.label ?? node.identifier}]: `);
          children(node.children, '\n\n', depth);
          break;
        case 'blockquote':
          // A text gutter also works for nested quotes containing code and links, for which
          // Telegram forbids overlapping blockquote/code/link entities.
          node.children.forEach((child, index) => {
            if (index) append('\n\n');
            append('│ ');
            render(child, depth);
          });
          break;
        case 'list':
          node.children.forEach((item, index) => {
            if (index) append('\n');
            append(
              '  '.repeat(depth) +
                (item.checked != null
                  ? item.checked
                    ? '☑ '
                    : '☐ '
                  : node.ordered
                    ? `${(node.start ?? 1) + index}. `
                    : '• '),
            );
            children(item.children, '\n', depth + 1);
          });
          break;
        case 'thematicBreak':
          append('────────');
          break;
        case 'table': {
          // sendMessage has no table entity. Label rows for narrow mobile screens.
          const headers = node.children[0]?.children ?? [];
          if (node.children.length === 1) {
            headers.forEach((header, index) => {
              if (index) append(' · ');
              span('bold', () => children(header.children));
            });
          }
          node.children.slice(1).forEach((row, rowIndex) => {
            if (rowIndex) append('\n\n');
            row.children.forEach((cell, index) => {
              if (index) append('\n');
              const header = headers[index];
              if (header?.children.length) {
                span('bold', () => children(header.children));
                append(': ');
              }
              children(cell.children);
            });
          });
          break;
        }
        default:
          if ('children' in node) children(node.children, '', depth);
          else if ('value' in node && typeof node.value === 'string') append(node.value);
      }
    };
    render(root);
    // Code/pre must never overlap another entity. Styles may contain links and each other.
    const code = entities
      .filter((entity) => entity.type === 'code' || entity.type === 'pre')
      .sort((a, b) => a.offset - b.offset);
    const normalized: TelegramEntity[] = [];
    for (const entity of entities) {
      if (entity.type === 'code' || entity.type === 'pre') {
        normalized.push(entity);
        continue;
      }
      // Find only overlapping code spans; scanning every code for every style blocks the
      // daemon on long, code-heavy answers. Code spans themselves are disjoint in the AST.
      let lo = 0;
      let hi = code.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const block = code[mid]!;
        if (block.offset + block.length <= entity.offset) lo = mid + 1;
        else hi = mid;
      }
      let cursor = entity.offset;
      const end = entity.offset + entity.length;
      for (let index = lo; index < code.length && code[index]!.offset < end; index++) {
        const block = code[index]!;
        if (block.offset > cursor)
          normalized.push({ ...entity, offset: cursor, length: block.offset - cursor });
        cursor = Math.max(cursor, Math.min(end, block.offset + block.length));
      }
      if (cursor < end) normalized.push({ ...entity, offset: cursor, length: end - cursor });
    }
    const unique = [
      ...new Map(normalized.map((entity) => [JSON.stringify(entity), entity])).values(),
    ].sort((a, b) => a.offset - b.offset || b.length - a.length);
    return { text, ...(unique.length ? { entities: unique } : {}) };
  } catch {
    // Malformed/unusually deep input must not prevent delivery of the answer.
    return { text: clean };
  }
}

/** Split rendered text and its UTF-16 spans together; labels must stay outside entity ranges. */
export function telegramFormattedChunks(
  message: TelegramFormattedChunk,
  token: string | null = null,
): TelegramFormattedChunk[] {
  // Markdown can reconstruct a secret across adjacent styled nodes. Redact the final text
  // as well, remapping spans before chunking instead of exposing it across message boundaries.
  const matches: number[] = [];
  if (token) {
    for (
      let at = message.text.indexOf(token);
      at !== -1;
      at = message.text.indexOf(token, at + token.length)
    )
      matches.push(at);
  }
  const remap = (offset: number, end: boolean) => {
    let shift = 0;
    for (const at of matches) {
      if (offset <= at) break;
      if (offset < at + token!.length) return at + shift + (end ? '[redacted]'.length : 0);
      shift += '[redacted]'.length - token!.length;
    }
    return offset + shift;
  };
  const text = redact(message.text, token) || '내용 없음';
  const entities = (message.entities ?? [])
    // A secret assembled from separate code/style nodes must not merge incompatible spans.
    .filter(
      (entity) =>
        !matches.some(
          (at) => entity.offset < at + token!.length && entity.offset + entity.length > at,
        ),
    )
    .map((entity) => ({
      ...entity,
      offset: remap(entity.offset, false),
      length: remap(entity.offset + entity.length, true) - remap(entity.offset, false),
    }))
    .filter((entity) => entity.length > 0);
  const parts: TelegramFormattedChunk[] = [];
  const limit = 3500;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    const spans = entities.filter(
      (entity) => entity.offset < end && entity.offset + entity.length > start,
    );
    // Stay below Telegram's entity count limit even for dense lists of tiny styled words.
    if (spans.length > 90 && spans[90]!.offset > start) end = spans[90]!.offset;
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n', end - 1);
      if (paragraph >= start + limit / 2) end = paragraph + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    }
    const clipped = spans
      .flatMap((entity) => {
        const left = Math.max(start, entity.offset);
        const right = Math.min(end, entity.offset + entity.length);
        return right > left ? [{ ...entity, offset: left - start, length: right - left }] : [];
      })
      .slice(0, 90);
    parts.push({ text: text.slice(start, end), ...(clipped.length ? { entities: clipped } : {}) });
    start = end;
  }
  return parts.length === 1
    ? parts
    : parts.map((part, index) => {
        const label = `[${index + 1}/${parts.length}]\n`;
        return {
          text: label + part.text,
          ...(part.entities
            ? {
                entities: part.entities.map((entity) => ({
                  ...entity,
                  offset: entity.offset + label.length,
                })),
              }
            : {}),
        };
      });
}
