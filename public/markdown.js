const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function inline(text) {
  const code = [];
  const placeholders = String(text).replace(/`([^`]+)`/g, (_, value) => {
    code.push(value);
    return `\u0000CODE${code.length - 1}\u0000`;
  });
  return escapeHtml(placeholders)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\u0000CODE(\d+)\u0000/g, (_, index) => `<code>${escapeHtml(code[Number(index)])}</code>`);
}

function cells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

export function renderMarkdown(markdown = "") {
  const lines = String(markdown).replaceAll("\r\n", "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) output.push(`</${list}>`);
    list = null;
  };
  const beforeBlock = () => { flushParagraph(); closeList(); };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^```/.test(line.trim())) {
      beforeBlock();
      const language = line.trim().slice(3).trim();
      const code = [];
      while (++index < lines.length && !/^```/.test(lines[index].trim())) code.push(lines[index]);
      output.push(`<pre><code${language ? ` data-language="${escapeHtml(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || "")) {
      beforeBlock();
      const headers = cells(line);
      index++;
      const rows = [];
      while (index + 1 < lines.length && lines[index + 1].includes("|") && lines[index + 1].trim()) rows.push(cells(lines[++index]));
      output.push(`<div class="markdown-table"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${inline(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      beforeBlock();
      const level = Math.min(heading[1].length + 1, 4);
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const item = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
    if (item) {
      flushParagraph();
      const kind = item[1].endsWith(".") ? "ol" : "ul";
      if (list !== kind) { closeList(); output.push(`<${kind}>`); list = kind; }
      output.push(`<li>${inline(item[2])}</li>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { beforeBlock(); output.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
    if (!line.trim()) { beforeBlock(); continue; }
    paragraph.push(line.trim());
  }

  beforeBlock();
  return output.join("");
}
