// Boreas frontend module: sources, Markdown, math, highlighting, and tool result visuals.
// Loaded as a classic script in the exact order declared by index.html.
import type { ChatMessage } from "../types/chat";

type MarkdownText = Extract<ChatMessage["content"], string>;

interface MarkedRenderer {
  link(href: string | null | undefined, title: string | null | undefined, text: MarkdownText): string;
  code(code: string, language?: string): string;
}
interface MarkedApi {
  Renderer: new () => MarkedRenderer;
  parse(text: MarkdownText): string;
  use(options: { gfm: boolean; breaks: boolean; renderer: MarkedRenderer }): void;
}
interface DomPurifyApi {
  addHook(name: "afterSanitizeAttributes", hook: (node: Element) => void): void;
  sanitize(html: string, options?: { ADD_ATTR?: string[] }): string;
}
interface HighlightApi {
  getLanguage(name: string): unknown;
  highlight(code: string, options: { language: string }): { value: string };
}
interface ChartConstructor {
  new (context: CanvasRenderingContext2D | null, config: unknown): unknown;
}
interface ImageSourceRecord { url?: unknown; favicon?: unknown; title?: unknown }
interface ParsedImage { url?: unknown; source_url?: unknown; description?: unknown; domain?: unknown }
interface ParsedDataset { label?: unknown; data?: unknown }

declare global {
  var marked: MarkedApi | undefined;
  var DOMPurify: DomPurifyApi | undefined;
  var hljs: HighlightApi | undefined;
  var renderMathInElement: ((element: HTMLElement, options: { delimiters: Array<{ left: string; right: string; display: boolean }>; throwOnError: boolean }) => void) | undefined;
  var Chart: ChartConstructor | undefined;
  interface Window { Chart?: ChartConstructor }
  interface HTMLElement {
    _renderedMarkdownText?: string;
    _streamFadeCleanup?: ReturnType<typeof setTimeout>;
  }
}

function isMarkupRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeExternalUrl(raw: unknown): string | null {
  try {
    const parsed = new URL(String(raw ?? ""), location.href);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

function createSourcesButton(sources: unknown[]): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "sources-btn-wrap";

  const btn = document.createElement("button");
  btn.className = "msg-action-btn";
  btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Fontes`;

  const dropdown = document.createElement("div");
  dropdown.className = "sources-dropdown";
  const titleEl = document.createElement("div");
  titleEl.className = "sources-dropdown-title"; titleEl.textContent = "Pesquisa na web";
  dropdown.appendChild(titleEl);

  sources.forEach((rawSource: unknown) => {
    if (!isMarkupRecord(rawSource)) return;
    const s = rawSource as ImageSourceRecord;
    const sourceUrl = safeExternalUrl(s.url);
    if (!sourceUrl) return;
    const a = document.createElement("a");
    a.className = "sources-link"; a.href = sourceUrl; a.target = "_blank"; a.rel = "noopener noreferrer";
    try {
      const ico = document.createElement("img");
      ico.src = safeExternalUrl(s.favicon) ?? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(sourceUrl).hostname)}&sz=32`;
      ico.onerror = () => { ico.style.display = "none"; };
      a.appendChild(ico);
    } catch {}
    const lbl = document.createElement("span"); lbl.textContent = typeof s.title === "string" ? s.title : sourceUrl;
    a.appendChild(lbl);
    dropdown.appendChild(a);
  });

  let closeHandler: ((event: PointerEvent) => void) | null = null;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const isOpen = dropdown.classList.toggle("open");
    if (isOpen) {
      const listener = (ev: PointerEvent): void => {
        if (!(ev.target instanceof Node) || !wrap.contains(ev.target)) {
          dropdown.classList.remove("open");
          document.removeEventListener("pointerdown", listener);
          closeHandler = null;
        }
      };
      closeHandler = listener;
      setTimeout(() => document.addEventListener("pointerdown", listener), 10);
    } else if (closeHandler) {
      document.removeEventListener("pointerdown", closeHandler);
    }
  });

  wrap.appendChild(dropdown);
  wrap.appendChild(btn);
  return wrap;
}

if (typeof DOMPurify !== 'undefined') {
  // Normalizes links' target and rel attributes to keep navigation safe.
  DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
    if (String(node.tagName ?? '').toUpperCase() === 'A' && node.hasAttribute('target')) {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

if (typeof marked !== 'undefined') {
  const renderer = new marked.Renderer();
  const _origLink = renderer.link.bind(renderer);
  renderer.link = (href: string | null | undefined, title: string | null | undefined, text: string) => {
    const html = _origLink(safeExternalUrl(href) ?? "", title, text);
    return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
  };
  renderer.code = (code: string, lang?: string) => {
    const language = (lang && typeof hljs !== 'undefined' && hljs.getLanguage(lang)) ? lang : 'plaintext';
    const highlighted = (typeof hljs !== 'undefined')
      ? hljs.highlight(code, { language }).value
      : code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
  };
  marked.use({
    gfm: true,
    breaks: false,
    renderer,
  });
}

interface MarkdownRenderState { text: string; timer: ReturnType<typeof setTimeout> }
const _markdownRenderState = new WeakMap<HTMLElement, MarkdownRenderState>();
const _mathMarkerRe = /\$\$|\$[^$\n]+\$|\\\(|\\\[/;
const MARKDOWN_RENDER_INTERVAL_MS = 33;

// Counts completed sentences/paragraphs so the fade-in below can trigger
// once per sentence instead of once per ~33ms render.
function _countSentenceEnds(str: string | undefined): number {
  const m = String(str ?? "").match(/[.!?](?:["')\]]?(?:\s|$))|\n\s*\n/g);
  return m ? m.length : 0;
}

function renderMarkdownNow(el: HTMLElement, text: MarkdownText): void {
  if (!el || el._renderedMarkdownText === text) return;
  const grew = typeof el._renderedMarkdownText === "string" && text.startsWith(el._renderedMarkdownText);
  const _prevText = el._renderedMarkdownText;
  el._renderedMarkdownText = text;
  try {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      const rawHtml = marked.parse(text);
      // marked always leaves a trailing "\n" at the end of the HTML. This
      // becomes a loose text node after the last tag, and since
      // .bubble.user uses white-space:pre-wrap, that \n renders as a real
      // blank line at the end of every message. Trimming avoids the bubble
      // looking taller than the typed text needs.
      el.innerHTML = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'rel'] }).trim();
    } else {

      el.innerHTML = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
      return;
    }
    // KaTeX walks the whole bubble. Most messages contain no math, so avoid
    // paying that cost unless a math delimiter is actually present.
    if (typeof renderMathInElement !== 'undefined' && _mathMarkerRe.test(text)) {
      renderMathInElement(el, {
        delimiters: [
          {left:"$$",right:"$$",display:true},
          {left:"$",right:"$",display:false},
          {left:"\\(",right:"\\)",display:false},
          {left:"\\[",right:"\\]",display:true}
        ],
        throwOnError: false
      });
    }
  } catch {

    el.textContent = text;
  } finally {
    // Smooth generation fade-in: markdown must be re-parsed on the full
    // accumulated text each render (an open "**" mid-word breaks the
    // parser otherwise), so this can't be genuinely append-only at the DOM
    // node level without risking broken formatting. The fade targets
    // ".stream-fade-in > :last-child" (the whole last block), so firing it
    // on every ~33ms render - as text keeps growing inside that same
    // block - just kept re-fading the entire accumulated paragraph, which
    // read as a flicker instead of a smooth reveal. Firing it only when a
    // new sentence/paragraph has actually completed fixes that, and
    // incidentally also cuts how often the forced reflow below runs.
    if (grew && el.isConnected) {
      const prevSentences = _countSentenceEnds(_prevText);
      const newSentences = _countSentenceEnds(text);
      if (newSentences > prevSentences) {
        el.classList.remove("stream-fade-in");
        // Forces a reflow so the animation restarts even if the previous one
        // is still finishing.
        void el.offsetWidth;
        el.classList.add("stream-fade-in");
        clearTimeout(el._streamFadeCleanup);
        el._streamFadeCleanup = setTimeout(() => el.classList.remove("stream-fade-in"), 220);
      }
    }
  }
}

function renderMarkdown(el: HTMLElement, text: MarkdownText): void {
  const pending = _markdownRenderState.get(el);
  if (pending) {
    clearTimeout(pending.timer);
    _markdownRenderState.delete(el);
  }
  renderMarkdownNow(el, text);
}

// Limit expensive Markdown/highlight/math work during live streaming while
// keeping the final answer exact and immediately available to the user.
function scheduleMarkdownRender(el: HTMLElement | null, text: MarkdownText): void {
  if (!el) return;
  const pending = _markdownRenderState.get(el);
  if (pending) {
    pending.text = text;
    return;
  }
  let state: MarkdownRenderState;
  const timer = setTimeout(() => {
    _markdownRenderState.delete(el);
    if (el.isConnected) renderMarkdownNow(el, state.text);
  }, MARKDOWN_RENDER_INTERVAL_MS);
  state = { text, timer };
  _markdownRenderState.set(el, state);
}

// Static copy of TOOL_META (the other instances are local to the streaming
// functions), just to rebuild the step timeline from saved history,
// outside of any live stream.
// Compatibility metadata for older persisted tool steps. The active renderer
// uses Phosphor classes too; keeping this map emoji-free prevents the legacy
// path from reintroducing a second icon language.
const TOOL_META_STATIC = {
  WEB_SEARCH: { icon: "ph-magnifying-glass" }, WEB_FETCH: { icon: "ph-globe" },
  BASH: { icon: "ph-terminal-window" }, DELETE: { icon: "ph-trash" },
  STR_REPLACE: { icon: "ph-pencil-line" }, SEND_FILE: { icon: "ph-paperclip" },
  CREATE_FILE: { icon: "ph-file-plus" }, MEMORY: { icon: "ph-brain" },
  PREFERENCES: { icon: "ph-gear" }, ASK_USER: { icon: "ph-question" },
  CALCULATOR: { icon: "ph-function" }, GRAPH: { icon: "ph-chart-line-up" },
  FORWARD_MESSAGE: { icon: "ph-arrow-up-right" }, USE_PLUGIN: { icon: "ph-puzzle-piece" },
  DEEP_RESEARCH: { icon: "ph-flask" }, AGENTIC_LOOP: { icon: "ph-arrows-clockwise" },
  IMAGE_SEARCH: { icon: "ph-magnifying-glass" }, PRESENT_IMAGE: { icon: "ph-image" },
  VIEW_CHATS: { icon: "ph-chats" }, CURRENCY: { icon: "ph-currency-circle-dollar" }
};

// Fills in a task item's (expanded) body. Shared across every rendering
// point (history, live stream, regeneration); GRAPH is special and draws a
// real chart via Chart.js from the JSON the backend returns, while every
// other tool falls back to the usual cmd/output pair in a <pre>. Idempotent:
// can be called again on the same body (e.g. when the final result arrives
// after the "pending" state) and it rebuilds.
// Builds the visual card (image gallery / currency / chart) from a tool's
// output; used both inside the "Thinking process" accordion and (via
// showInlineToolResult) directly in the message. Returns null if the tool
// has no visual representation or the JSON isn't in the expected shape.
function buildToolResultVisual(tool: string, output: unknown, value?: string): HTMLElement | null {
  if (!output) return null;
  if (tool === "CALCULATOR") {
    // Renders the calculator's text output as a simple card, without expecting JSON.
    const lines = String(output).split("\n").filter(Boolean);
    if (!lines.length) return null;
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:4px;padding:16px 18px;border-radius:10px;background:var(--surface);border:1px solid var(--border);max-width:320px";
    if (value) {
      const label = document.createElement("div");
      label.style.cssText = "font-size:12px;color:var(--text-dim);margin-bottom:6px;font-family:monospace";
      label.textContent = value;
      wrap.appendChild(label);
    }
    lines.forEach((line, i) => {
      const row = document.createElement("div");
      row.style.cssText = i === 0
        ? "font-size:19px;font-weight:700;color:var(--text);word-break:break-word"
        : "font-size:12px;color:var(--text-faint);margin-top:6px;word-break:break-word";
      row.textContent = line;
      wrap.appendChild(row);
    });
    return wrap;
  }
  if (tool === "PRESENT_IMAGE") {
    try {
      const serialized = String(output ?? "");
      if (serialized.length > 1_000_000) return null;
      const parsed: unknown = JSON.parse(serialized);
      if (!isMarkupRecord(parsed)) return null;
      const spec = parsed;
      const imgs: ParsedImage[] = (Array.isArray(spec.images) ? spec.images.filter(isMarkupRecord) : []).slice(0, 20);
      if (!imgs.length) return null;
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-top:4px";
      if (typeof spec.caption === "string" && spec.caption) {
        const cap = document.createElement("div");
        cap.style.cssText = "font-size:12px;color:var(--text-dim);margin-bottom:6px";
        cap.textContent = spec.caption;
        wrap.appendChild(cap);
      }
      const gallery = document.createElement("div");
      gallery.style.cssText = "display:flex;gap:10px;overflow-x:auto;padding:2px 2px 6px";
      for (const im of imgs) {
        const imageUrl = safeExternalUrl(im?.url);
        const sourceUrl = safeExternalUrl(im?.source_url || im?.url);
        if (!imageUrl || !sourceUrl) continue;
        const card = document.createElement("a");
        card.href = sourceUrl;
        card.target = "_blank";
        card.rel = "noopener noreferrer";
        card.title = typeof im.description === "string" ? im.description : typeof im.domain === "string" ? im.domain : "";
        card.style.cssText = "position:relative;flex:0 0 auto;width:200px;height:150px;border-radius:10px;overflow:hidden;display:block;background:var(--surface);border:1px solid var(--border)";
        const img = document.createElement("img");
        img.src = imageUrl; img.loading = "lazy"; img.alt = typeof im.description === "string" ? im.description : typeof im.domain === "string" ? im.domain : "";
        img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
        const pill = document.createElement("span");
        pill.style.cssText = "position:absolute;left:8px;bottom:8px;display:flex;align-items:center;gap:5px;background:rgba(20,20,20,.92);color:#fff;font-size:11px;padding:5px 9px;border-radius:999px;max-width:calc(100% - 16px);overflow:hidden";
        if (typeof im.domain === "string" && im.domain) {
          const fav = document.createElement("img");
          try { fav.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(sourceUrl).hostname)}&sz=32`; } catch { fav.remove(); }
          fav.style.cssText = "width:12px;height:12px;border-radius:2px;flex-shrink:0";
          pill.appendChild(fav);
        }
        const domainSpan = document.createElement("span");
        domainSpan.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        domainSpan.textContent = typeof im.domain === "string" ? im.domain : "imagem";
        pill.appendChild(domainSpan);
        card.appendChild(img); card.appendChild(pill);
        gallery.appendChild(card);
      }
      wrap.appendChild(gallery);
      return wrap;
    } catch (e) { return null; }
  }
  if (tool === "CURRENCY") {
    try {
      const parsed: unknown = JSON.parse(String(output));
      if (!isMarkupRecord(parsed)) return null;
      const spec = parsed;
      const symbols: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", BRL: "R$" };
      const sym = (currency: unknown): string => symbols[String(currency)] ?? `${String(currency)} `;
      const fmt = (amount: unknown, currency: unknown): string => sym(currency) + Number(amount).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-top:4px;padding:16px 18px;border-radius:10px;background:var(--surface);border:1px solid var(--border);max-width:320px";
      const label = document.createElement("div");
      label.style.cssText = "font-size:12px;color:var(--text-dim);margin-bottom:6px";
      label.textContent = "Câmbio";
      const main = document.createElement("div");
      main.style.cssText = "font-size:21px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px;flex-wrap:wrap";
      main.textContent = `${fmt(spec.amount, spec.from)} → ${fmt(spec.result, spec.to)}`;
      const sub = document.createElement("div");
      sub.style.cssText = "font-size:12px;color:var(--text-faint);margin-top:8px";
      const dateTxt = spec.date ? ` · atualizado em ${new Date(String(spec.date)).toLocaleDateString("pt-BR")}` : "";
      sub.textContent = `1 ${spec.from} = ${Number(spec.rate).toLocaleString("pt-BR", { maximumFractionDigits: 6 })} ${spec.to}${dateTxt}`;
      wrap.appendChild(label); wrap.appendChild(main); wrap.appendChild(sub);
      return wrap;
    } catch (e) { return null; }
  }
  if (tool === "GRAPH") {
    try {
      const parsed: unknown = JSON.parse(String(output));
      if (!isMarkupRecord(parsed)) return null;
      const spec = parsed;
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:relative;width:100%;max-width:480px;height:280px;margin-top:4px";
      const canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      const ChartLibrary = window.Chart;
      if (!ChartLibrary) {
        // CDN failures must remain visible as a useful result instead of
        // silently dropping the graph card.
        canvas.remove();
        const fallback = document.createElement("div");
        fallback.style.cssText = "height:100%;overflow:auto;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);font-size:12px";
        const title = document.createElement("div");
        title.textContent = typeof spec.title === "string" ? spec.title : "Gráfico";
        title.style.cssText = "font-weight:700;margin-bottom:8px";
        fallback.appendChild(title);
        const table = document.createElement("table");
        table.style.cssText = "width:100%;border-collapse:collapse";
        const graphData = isMarkupRecord(spec.data) ? spec.data : {};
        const labels: unknown[] = Array.isArray(graphData.labels) ? graphData.labels : [];
        const datasets: ParsedDataset[] = Array.isArray(graphData.datasets) ? graphData.datasets.filter(isMarkupRecord) : [];
        for (const dataset of datasets) {
          const row = document.createElement("tr");
          const name = document.createElement("th"); name.textContent = typeof dataset.label === "string" ? dataset.label : "Série"; name.style.textAlign = "left";
          const values = document.createElement("td");
          values.textContent = (Array.isArray(dataset.data) ? dataset.data : []).map((value: unknown, i: number) => `${labels[i] ?? i + 1}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ");
          values.style.paddingLeft = "8px";
          row.append(name, values); table.appendChild(row);
        }
        fallback.appendChild(table); wrap.appendChild(fallback); return wrap;
      }
      // Defers chart creation until the container is in the DOM and
      // visible, so Chart.js can measure the right size.
      requestAnimationFrame(() => {
        if (!canvas.isConnected) return;
        new ChartLibrary(canvas.getContext("2d"), {
          type: spec.chart_type || "bar",
          data: spec.data,
          options: Object.assign(
            { responsive: true, maintainAspectRatio: false,
              plugins: { title: { display: !!spec.title, text: typeof spec.title === "string" ? spec.title : "" }, legend: { display: (isMarkupRecord(spec.data) && Array.isArray(spec.data.datasets) ? spec.data.datasets.length : 0) > 1 } } },
            spec.options || {}
          ),
        });
      });
      return wrap;
    } catch (e) { return null; }
  }
  return null;
}
// Shows a tool's visual result directly in the model's message, instead of
// only hidden inside the "Thinking process" accordion.
// container: where to insert it (masterCol/col). before: an element to
// insert it before (usually the responseBubble), or null to go at the end.
// _shownIds avoids duplicating the card if the same step updates again.
const _inlineToolShown = new WeakMap();
function showInlineToolResult(container: HTMLElement | null, stepId: string, tool: string, output: unknown, before: HTMLElement | null, value?: string): void {
  if (!container || !stepId) return;
  let shown = _inlineToolShown.get(container);
  if (!shown) { shown = new Set(); _inlineToolShown.set(container, shown); }
  if (shown.has(stepId)) return;
  const visual = buildToolResultVisual(tool, output, value);
  if (!visual) return;
  shown.add(stepId);
  if (before && before.parentNode === container) container.insertBefore(visual, before);
  else container.appendChild(visual);
}

export {};
