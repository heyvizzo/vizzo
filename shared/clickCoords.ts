// Where a click landed, in px and in % of two boxes: the element pressed (the container) and the whole page.
// The % values are what hold across screen sizes (the same spot is the same % at any width); the px are for
// reading the exact spot. Pure, so the recorder (web/cursor/pageContext.ts) and the tests share it.
import type { ClickCoords, Pt, Size } from "./protocol.ts";

const px = (v: number) => Number(v.toFixed(1));
const pct = (v: number, total: number) => (total > 0 ? Number(((v / total) * 100).toFixed(2)) : 0);

/**
 * `client` = the pointer in the viewport, `scroll` = window scroll, `pageSize` = the document's scroll size,
 * `box` = the pressed element's getBoundingClientRect() (its left/top in viewport px).
 */
export function clickCoords(client: Pt, scroll: Pt, pageSize: Size, box: { left: number; top: number; width: number; height: number }): ClickCoords {
  const inBox = { x: client.x - box.left, y: client.y - box.top };
  const onPage = { x: client.x + scroll.x, y: client.y + scroll.y };
  const boxSize = { width: box.width, height: box.height };
  return {
    container: { size: boxSize, at: { px: { x: px(inBox.x), y: px(inBox.y) }, pct: { x: pct(inBox.x, box.width), y: pct(inBox.y, box.height) } } },
    page: { size: { ...pageSize }, at: { px: { x: px(onPage.x), y: px(onPage.y) }, pct: { x: pct(onPage.x, pageSize.width), y: pct(onPage.y, pageSize.height) } } },
  };
}

/** "30%, 68% (120, 34 px) of its 400×100 box, 25%, 18.5% (500, 740 px) of the 2000×4000 page". */
export function formatCoords(c: ClickCoords): string {
  const { container: b, page: p } = c;
  return `${b.at.pct.x}%, ${b.at.pct.y}% (${b.at.px.x}, ${b.at.px.y} px) of its ${b.size.width}×${b.size.height} box, `
    + `${p.at.pct.x}%, ${p.at.pct.y}% (${p.at.px.x}, ${p.at.px.y} px) of the ${p.size.width}×${p.size.height} page`;
}
