/**
 * What tests/e2e/parent-a11y.spec.ts measures in the page itself, beside axe-core: sideways scrolling, text clipped by
 * its box, text drawn over other text, and tap targets under 48 by 48 CSS pixels. Each finding names the element by a
 * short CSS path and the start of its text.
 *
 * `layoutProblems` runs inside the browser (page.evaluate sends its source), so it must stay self-contained: no imports,
 * nothing from this module's scope. It reads the page and changes nothing but the scroll position, which it puts back.
 */
export type LayoutProblem = { element: string; problem: string };

/** The smallest tap target, in CSS pixels, on every side (PRODUCT.md and docs/agents/ui.md: M3's 48px, more than WCAG 2.5.8's 24). */
export const MIN_TARGET = 48;

export function layoutProblems(minTarget: number): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const root = document.documentElement;
  const SLACK = 1; // a pixel of rounding is not a finding

  const describe = (el: Element): string => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.body && parts.length < 5; e = e.parentElement) {
      let part = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(`${part}#${e.id}`); break; }
      const classes = [...e.classList].slice(0, 2);
      if (classes.length) part += `.${classes.join(".")}`;
      const parent = e.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === e!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(part);
    }
    const name = (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
    return `${parts.join(" > ")}${name ? ` "${name.slice(0, 60)}"` : ""}`;
  };

  // Hidden on purpose: a .visually-hidden span (1px, clipped) is for screen readers, and is not drawn text.
  const visuallyHidden = (el: Element | null): boolean => {
    for (let e = el; e && e !== root; e = e.parentElement) {
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      if (s.position === "absolute" && r.width <= 1 && r.height <= 1) return true;
      if (s.visibility === "hidden" || s.opacity === "0") return true;
    }
    return false;
  };
  const isFixed = (el: Element | null): boolean => {
    for (let e = el; e && e !== root; e = e.parentElement) if (getComputedStyle(e).position === "fixed") return true;
    return false;
  };
  const intersect = (a: DOMRect, b: DOMRect) => ({
    w: Math.min(a.right, b.right) - Math.max(a.left, b.left),
    h: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  });

  // 1. Nothing scrolls the page sideways. Name the elements that reach past the right edge, deepest first.
  if (root.scrollWidth > root.clientWidth + SLACK) {
    const width = root.clientWidth;
    const wide = [...document.body.querySelectorAll("*")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > width + SLACK && !visuallyHidden(e);
    });
    const deepest = wide.filter((e) => !wide.some((o) => o !== e && e.contains(o)));
    problems.push({ element: deepest.slice(0, 3).map(describe).join("; ") || "html",
      problem: `the page scrolls sideways: it is ${root.scrollWidth}px wide in a ${width}px window` });
  }

  // The words drawn on the page: every text node with something in it, with the boxes its lines take.
  type Run = { node: Text; el: Element; rects: DOMRect[]; fixed: boolean };
  const runs: Run[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text, el = node.parentElement;
    if (!el || !node.data.trim() || el.closest("script, style, noscript, template, svg")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length || visuallyHidden(el)) continue;
    runs.push({ node, el, rects, fixed: isFixed(el) });
  }

  // 2. Text clipped by its box: a line that reaches outside an element that hides what overflows it. A name cut short
  // on purpose, with an ellipsis or a line clamp the design asks for (the club name, the step labels), is
  // not clipped: the reader sees that it goes on. A box that scrolls is not clipping either.
  const clipped = new Set<Element>();
  for (const run of runs) {
    for (let a = run.el; a && a !== root; a = a.parentElement!) {
      const s = getComputedStyle(a);
      const hidesX = s.overflowX === "hidden" || s.overflowX === "clip", hidesY = s.overflowY === "hidden" || s.overflowY === "clip";
      if (!hidesX && !hidesY) continue;
      if (s.textOverflow === "ellipsis" || (s.webkitLineClamp && s.webkitLineClamp !== "none")) break;
      const box = a.getBoundingClientRect();
      const left = box.left + a.clientLeft, top = box.top + a.clientTop;
      const right = left + a.clientWidth, bottom = top + a.clientHeight;
      const out = run.rects.some((r) => (hidesX && (r.left < left - SLACK || r.right > right + SLACK))
        || (hidesY && (r.top < top - SLACK || r.bottom > bottom + SLACK)));
      if (out && !clipped.has(run.el)) {
        clipped.add(run.el);
        problems.push({ element: describe(run.el), problem: `its text is clipped by ${describe(a).split(" \"")[0]}, which hides what overflows it` });
      }
      break;
    }
  }

  // 3. Text drawn over other text. Two runs overlap when their lines share more than a sliver: a third of the shorter
  // line's height, and more than 2px across (a line box can be a little taller than its line-height). Something
  // fixed on the screen (the tab bar) is compared with the page at the page's end, below, where nothing may be under it.
  const flagged = new Set<string>();
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i]!, b = runs[j]!;
      if (a.fixed !== b.fixed) continue;
      const hit = a.rects.some((ra) => b.rects.some((rb) => {
        const o = intersect(ra, rb);
        return o.w > 2 && o.h > Math.min(ra.height, rb.height) / 3;
      }));
      if (!hit) continue;
      const key = `${describe(a.el)}|${describe(b.el)}`;
      if (flagged.has(key)) continue;
      flagged.add(key);
      problems.push({ element: describe(a.el), problem: `its text overlaps the text of ${describe(b.el)}` });
    }
  }

  // At the page's end, nothing that scrolls may be left under something fixed (the tab bar): the body's bottom
  // padding is what keeps the last line clear of it.
  const fixedRuns = runs.filter((r) => r.fixed);
  if (fixedRuns.length) {
    const before = window.scrollY;
    window.scrollTo(0, root.scrollHeight);
    const fixedBoxes = [...new Set(fixedRuns.map((r) => {
      let e: Element = r.el;
      while (e.parentElement && getComputedStyle(e).position !== "fixed") e = e.parentElement;
      return e;
    }))];
    for (const box of fixedBoxes) {
      const fr = box.getBoundingClientRect();
      for (const run of runs.filter((r) => !r.fixed)) {
        const range = document.createRange();
        range.selectNodeContents(run.node);
        const under = [...range.getClientRects()].some((r) => { const o = intersect(r, fr); return o.w > 2 && o.h > 2; });
        if (under) {
          problems.push({ element: describe(run.el), problem: `at the end of the page its text is still under ${describe(box).split(" \"")[0]}` });
          break;
        }
      }
    }
    window.scrollTo(0, before);
  }

  // 4. Tap targets: every control at least minTarget by minTarget. A link inside a sentence is excepted, as WCAG 2.5.8
  // allows: its size is set by the line it sits in. A native radio or tick box drawn hidden inside its label is tapped
  // through the label, so the label is measured.
  const controls = document.querySelectorAll<HTMLElement>(
    "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [tabindex]:not([tabindex='-1'])");
  for (const control of controls) {
    if (control.closest("[inert], [hidden]")) continue;
    let target: HTMLElement = control;
    let r = control.getBoundingClientRect();
    if (control instanceof HTMLInputElement && r.width <= 1 && r.height <= 1) {
      const label = control.closest("label");
      if (!label) { problems.push({ element: describe(control), problem: "it is a hidden control with no label to tap" }); continue; }
      target = label; r = label.getBoundingClientRect();
    }
    if (r.width === 0 && r.height === 0) continue; // not drawn (display: none in this layout)
    if (getComputedStyle(target).visibility === "hidden" || visuallyHidden(target)) continue;
    if (control.tagName === "A" && getComputedStyle(control).display === "inline") {
      let block: Element | null = control.parentElement;
      while (block && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
      const around = (block?.textContent ?? "").replace(/\s+/g, "").length - (control.textContent ?? "").replace(/\s+/g, "").length;
      if (around > 0) continue; // in a sentence
    }
    if (r.width < minTarget - 0.5 || r.height < minTarget - 0.5) {
      problems.push({ element: describe(control), problem: `its tap target is ${Math.round(r.width)} by ${Math.round(r.height)}px, under ${minTarget} by ${minTarget}` });
    }
  }
  return problems;
}

/**
 * The element the keyboard is on, for tests/e2e/parent-a11y.spec.ts's Tab walk: a short description, and what is
 * wrong with how it is shown: no focus ring (an outline under 2px, or none; a hidden radio's ring is on its tile), or
 * the control left under something fixed on the screen (the phone's tab bar), which WCAG 2.4.11 forbids. Null when
 * the focus is on the page itself (it has left the last control). Runs in the browser: self-contained, like
 * layoutProblems.
 */
export function focusStop(): { element: string; problems: string[] } | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return null;
  const tile = el instanceof HTMLInputElement && el.closest(".choice") && el.nextElementSibling instanceof HTMLElement ? el.nextElementSibling : el;
  const s = getComputedStyle(tile);
  const name = (el.getAttribute("aria-label") ?? el.innerText ?? "").replace(/\s+/g, " ").trim()
    || (el instanceof HTMLInputElement ? (el.labels?.[0]?.innerText ?? "").replace(/\s+/g, " ").trim() : "");
  const classes = [...el.classList].slice(0, 2).join(".");
  const element = `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ""}${name ? ` "${name.slice(0, 60)}"` : ""}`;
  const problems: string[] = [];
  const width = parseFloat(s.outlineWidth);
  if ((s.outlineStyle === "none" || !(width >= 2) || /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(s.outlineColor))) {
    problems.push(`it has the focus and no visible focus ring (outline ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor})`);
  }
  const r = tile.getBoundingClientRect();
  for (const fixed of document.querySelectorAll<HTMLElement>("body *")) {
    if (getComputedStyle(fixed).position !== "fixed" || fixed.contains(el)) continue;
    const f = fixed.getBoundingClientRect();
    if (f.width && f.height && r.left < f.right && r.right > f.left && r.top < f.bottom && r.bottom > f.top + 1) {
      problems.push(`it has the focus and is partly hidden under ${fixed.tagName.toLowerCase()}.${[...fixed.classList].join(".")}`);
    }
  }
  return { element, problems };
}
