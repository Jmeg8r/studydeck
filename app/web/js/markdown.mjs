// WHAT: A small markdown → HTML renderer for the subset the fastbook sources use.
// WHY: Zero dependencies is a rule here, and the alternative (dropping a parser in) is
//      the one thing this repo is trying to avoid. Scope is deliberately narrow:
//      headings, fenced and inline code, lists, blockquotes, rules, emphasis, links.
//
// SAFETY: HTML is escaped FIRST, before any markdown transform, and code fences are
// lifted out before inline rules run. That ordering is what makes the output safe to
// assign with innerHTML — source text arrives from Open Notebook, which is not a
// trust boundary the browser should be asked to evaluate.

// Quotes matter as much as angle brackets here. Link hrefs are interpolated into an
// attribute, so an unescaped `"` closes it early — and browsers recover from the missing
// whitespace between attributes, turning `[x](https://a"onmouseover="alert(1))` into a
// live event handler. Escaping only &, < and > left that hole open.
const escapeHtml = (text) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Inline rules, applied to already-escaped text with code spans lifted out. */
function inline(text) {
  return text
    // Links: [label](url). Only http(s) and relative targets survive — anything else
    // (javascript:, data:) degrades to plain label text rather than a live link.
    // The href pattern allows one level of balanced parens, which URLs really do use.
    .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (match, label, href) =>
      /^(https?:\/\/|\/|#)/.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
}

export function renderMarkdown(markdown) {
  const escaped = escapeHtml(markdown ?? '');

  // Lift fenced code out first so nothing inside it is treated as markdown.
  const blocks = [];
  const withoutFences = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    blocks.push(`<pre class="md-code"${lang ? ` data-lang="${lang}"` : ''}><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\0BLOCK${blocks.length - 1}\0`;
  });

  // Then inline code, for the same reason.
  const spans = [];
  const withoutCode = withoutFences.replace(/`([^`\n]+)`/g, (match, code) => {
    spans.push(`<code class="md-inline">${code}</code>`);
    return `\0SPAN${spans.length - 1}\0`;
  });

  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const rawLine of withoutCode.split('\n')) {
    const line = rawLine.trimEnd();

    if (/^\0BLOCK\d+\0$/.test(line.trim())) {
      closeList();
      out.push(line.trim());
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level} id="${slugify(heading[2])}">${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(---+|\*\*\*+|___+)$/.test(line.trim())) {
      closeList();
      out.push('<hr>');
      continue;
    }

    // Matches the ESCAPED form: escaping runs first, so by here a leading `>` is
    // already `&gt;`. Matching a literal `>` silently never fires.
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const wanted = bullet ? 'ul' : 'ol';
      if (listType !== wanted) {
        closeList();
        out.push(`<${wanted}>`);
        listType = wanted;
      }
      out.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  // Restore the lifted content last, so it was never subject to inline rules.
  return out
    .join('\n')
    .replace(/\0SPAN(\d+)\0/g, (match, i) => spans[Number(i)])
    .replace(/\0BLOCK(\d+)\0/g, (match, i) => blocks[Number(i)]);
}

/** Stable heading id, used for the chapter outline links. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

/** Headings, for the in-chapter outline. */
export function outline(markdown) {
  const headings = [];
  let inFence = false;
  for (const line of (markdown ?? '').split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (inFence) continue;
    const match = line.match(/^(#{1,3})\s+(.*)$/);
    if (match) headings.push({ level: match[1].length, text: match[2].trim(), id: slugify(match[2]) });
  }
  return headings;
}
