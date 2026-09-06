/** Сборка HTML презентации — порт presentation-generator.ts из sbe-presentations
 *  (та часть, что не зависит от Obsidian/вольта: рендер слайдов уже принимает
 *  images как обычные URL, не пути в вольте — их незачем резолвить в data URI,
 *  Фотобанк/create_png и так отдают HTTPS-ссылки). Разметка/CSS/JS показа
 *  (слайды/лендинг, фулскрин, автопоказ, печать в PDF) — 1:1 с Obsidian-версией. */

import type {
  PresentationGeneration, PresentationTemplate, PresentationSlide,
  ElementPos, TemplateTitleLayout, TemplateCardsLayout, TemplateTableLayout,
  TemplatePhotoLayout, TemplateLayout, TemplateFinalLayout,
} from './presentationTypes';

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function upper(s: unknown, uppercase: boolean): string {
  return uppercase ? String(s ?? '').toUpperCase() : String(s ?? '');
}

type PosKey = 'left' | 'top' | 'right' | 'bottom';

function posUnit(v: number | string, axis: 'x' | 'y'): string {
  return typeof v === 'number' ? `${v}${axis === 'x' ? 'cqw' : 'cqh'}` : v;
}

function posCss(pos: ElementPos | undefined, defaults: Array<[PosKey, string]>): string {
  const map = new Map<PosKey | 'transform' | 'text-align', string>(defaults);
  if (pos?.align) {
    const a = pos.align;
    map.delete('left'); map.delete('top'); map.delete('right'); map.delete('bottom'); map.delete('transform');
    const vertical: 'top' | 'bottom' | 'mid' = a.includes('top') ? 'top' : a.includes('bottom') ? 'bottom' : 'mid';
    const horizontal: 'left' | 'right' | 'mid' = a.includes('left') ? 'left' : a.includes('right') ? 'right' : 'mid';
    if (vertical === 'top') map.set('top', '3.9cqh');
    else if (vertical === 'bottom') map.set('bottom', '3.9cqh');
    else { map.set('top', '50%'); map.set('transform', 'translateY(-50%)'); }
    if (horizontal === 'left') map.set('left', '4.45cqw');
    else if (horizontal === 'right') map.set('right', '4.45cqw');
    else { map.set('left', '4.45cqw'); map.set('right', '4.45cqw'); map.set('text-align', 'center'); }
  }
  if (pos) {
    if (pos.left !== undefined) map.set('left', posUnit(pos.left, 'x'));
    if (pos.right !== undefined) map.set('right', posUnit(pos.right, 'x'));
    if (pos.top !== undefined) { map.set('top', posUnit(pos.top, 'y')); map.delete('transform'); }
    if (pos.bottom !== undefined) { map.set('bottom', posUnit(pos.bottom, 'y')); map.delete('transform'); }
  }
  const parts: string[] = [];
  for (const [k, v] of map) parts.push(`${k}:${v}`);
  return parts.join(';');
}

/** fit по умолчанию — 'contain' (не обрезает): в отличие от Obsidian-версии,
 *  здесь иллюстрацией/фоном очень часто оказывается ГРАФИК (create_png), не
 *  фото — обрезка по краю отрезает подпись оси/легенду. Модель может явно
 *  попросить 'cover' для настоящего фото, которому обрезка ради заполнения
 *  рамки не вредит. См. docs/superpowers/specs/2026-09-06-web-agent-
 *  presentation-image-fit-design.md. */
function bgImageStyle(uri?: string, fit: 'cover' | 'contain' = 'contain'): string {
  if (!uri) return '';
  if (fit === 'contain') {
    return `background-image:url('${uri}');background-size:contain;background-repeat:no-repeat;background-position:center;`;
  }
  return `background-image:url('${uri}');background-size:cover;background-position:center;`;
}

function normalizeIllustrationPath(p: unknown): string {
  return String(p ?? '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .replace(/^\.?\//, '');
}

function resolveIllustration(
  imagePath: string | undefined,
  illustrations: Record<string, string>,
): string | undefined {
  if (!imagePath) return undefined;
  if (illustrations[imagePath]) return illustrations[imagePath];
  const norm = normalizeIllustrationPath(imagePath);
  if (!norm) return undefined;
  for (const [key, uri] of Object.entries(illustrations)) {
    if (normalizeIllustrationPath(key) === norm) return uri;
  }
  return undefined;
}

function buildVCard(presenter?: string, phone?: string, email?: string): string | null {
  if (!phone && !email) return null;
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${presenter || ''}`,
    `TEL:${phone || ''}`,
    `EMAIL:${email || ''}`,
    'END:VCARD',
  ].join('\n');
}

function buildCss(tpl: PresentationTemplate, transition: 'fade' | 'slide' | 'none' = 'fade', showProgress = true): string {
  const c = tpl.colors;
  const f = tpl.fonts;
  const l = tpl.layouts;
  const title: TemplateTitleLayout = l.title ?? ({} as TemplateTitleLayout);
  const titleSize = title.titleSize ?? f.titleSize ?? 3.4;
  const headerSize = f.titleSize ?? 2.7;
  const bodySize = f.bodySize ?? 1.05;
  const cqw = (px: number) => `${(px / 12.8).toFixed(3)}cqw`;
  const up = f.uppercase ? 'text-transform:uppercase;' : '';
  const cards: TemplateCardsLayout = l.cards ?? {};
  const table: TemplateTableLayout = l.table ?? {};
  const photo: TemplatePhotoLayout = l.photo ?? {};
  const section: TemplateLayout = l.section ?? {};
  const content: TemplateLayout = l.content ?? {};
  const bullets: TemplateLayout = l.bullets ?? {};
  const final: TemplateFinalLayout = l.final ?? {};

  return `
  * { box-sizing:border-box; margin:0; padding:0; }
  html,body { background:#fff; }
  body { font-family:"${f.body}", Arial, sans-serif; color:${c.dark}; }
  .toolbar { position:fixed; top:10px; right:12px; z-index:1000; display:flex; gap:8px; align-items:center; }
  .toolbar button {
    font-family:Arial, sans-serif; font-size:12px; cursor:pointer; border:1px solid ${c.border};
    background:${c.white}; color:${c.dark}; border-radius:4px; padding:4px 10px;
  }
  .toolbar button:hover { background:${c.light}; }
  :fullscreen .toolbar { display:none !important; }
  :-webkit-full-screen .toolbar { display:none !important; }
  .deck { max-width:1280px; margin:0 auto; padding:16px 0; }
  .slide {
    width:100%; aspect-ratio:16/9; container-type:size; position:relative; overflow:hidden;
    background:${c.bg ?? '#fff'}; margin-bottom:16px;
  }
  .slide:last-child { margin-bottom:0; }
  .deck.mode-slides { position:fixed; inset:0; max-width:none; margin:0; padding:0; z-index:999;
    background:#000; display:flex; align-items:center; justify-content:center; }
  .deck.mode-slides .slide {
    position:absolute; inset:0; margin:auto; aspect-ratio:auto;
    width:min(100vw, calc(100vh * 16 / 9));
    height:min(100vh, calc(100vw * 9 / 16));
    opacity:0; pointer-events:none; visibility:hidden;
    transition:opacity .45s ease, transform .45s ease, visibility 0s linear .45s;
  }
  .deck.mode-slides .slide.current { opacity:1; pointer-events:auto; visibility:visible; transition:opacity .45s ease, transform .45s ease; }
  .deck.mode-slides .slide.slide-in-left { transform:translateX(-7%); }
  .deck.mode-slides .slide.slide-in-right { transform:translateX(7%); }
  .deck.mode-slides .slide.slide-out-left { transform:translateX(-7%); }
  .deck.mode-slides .slide.slide-out-right { transform:translateX(7%); }
  ${transition === 'none' ? `
  .deck.mode-slides .slide { transition:none; }
  ` : ''}
  .progress { position:fixed; left:0; right:0; bottom:0; height:3px; z-index:1001; background:rgba(255,255,255,.25); display:none; }
  .deck.mode-slides ~ .progress { display:block; }
  .progress .bar { display:block; height:100%; width:0; background:${c.accent}; transition:width .3s ease; }
  ${showProgress ? '' : '.deck.mode-slides ~ .progress { display:none !important; }'}
  .foot {
    position:absolute; right:4.45cqw; bottom:3.9cqh; font-size:${cqw(13)};
    font-family:"${f.body}", Arial, sans-serif; color:${c.gray}; white-space:nowrap;
  }
  .foot .mark { display:none; }
  .s-final .foot { color:rgba(255,255,255,.75); }
  .s-photo .foot, .s-title .foot { color:rgba(255,255,255,.8); }

  /* ---------- Title ---------- */
  .s-title { background-color:${title.bg ?? c.dark}; }
  .s-title .t-img { position:absolute; inset:0; background-size:cover; background-position:center; }
  .s-title .t-overlay { position:absolute; inset:0; }
  .s-title .t-brand {
    position:absolute; ${posCss(title.pos?.brand, [['right', '4.45cqw'], ['top', '3.9cqh']])}; font-family:"${f.title}", Arial Black, sans-serif;
    color:${title.brandColor ?? c.white}; letter-spacing:.18em; font-size:${cqw(16)}; ${up}
  }
  .s-title .t-slogan {
    position:absolute; ${posCss(title.pos?.slogan, [['left', '4.45cqw'], ['top', '3.9cqh']])}; color:${title.sloganColor ?? c.white};
    font-size:${cqw(15)}; letter-spacing:.06em; ${up}
  }
  .s-title .t-kicker {
    position:absolute; ${posCss(title.pos?.kicker, [['left', '4.45cqw'], ['top', '17cqh']])}; color:${title.kickerColor ?? c.accent};
    font-size:1.172cqw; font-weight:bold; letter-spacing:.08em; ${up}
  }
  .s-title .t-title {
    position:absolute; ${posCss(title.pos?.title, [['left', '4.45cqw'], ['top', '30cqh'], ['right', '4.45cqw']])}; font-family:"${f.title}", Arial Black, sans-serif;
    color:${title.titleColor ?? c.white}; font-size:${titleSize}cqw; line-height:1.16; ${up}
  }
  .s-title .t-line { position:absolute; ${posCss(title.pos?.line, [['left', '4.55cqw'], ['top', '66cqh']])}; width:7cqw; height:0.4cqh; background:${c.accent}; }
  .s-title .t-speaker {
    position:absolute; ${posCss(title.pos?.speaker, [['left', '4.45cqw'], ['top', '70cqh'], ['right', '4.45cqw']])}; color:${title.speakerColor ?? c.white};
    font-size:${cqw(14)}; line-height:1.3;
  }

  /* ---------- Section / шмуцтитул ---------- */
  .s-section { background:${section.bg ?? c.bg ?? '#fff'}; }
  .s-section .sec-body { position:absolute; inset:0; display:grid; grid-template-columns:1fr 1fr; }
  .s-section .sec-img {
    background-size:cover; background-position:center; background-color:${c.light};
    border-right:1px solid ${c.border};
  }
  .s-section .sec-txt { display:flex; flex-direction:column; justify-content:center; padding:0 4.45cqw; }
  .s-section .h1 {
    font-family:"${f.title}", Arial Black, sans-serif; color:${section.accentColor ?? c.accent};
    font-size:${headerSize}cqw; line-height:1.15; ${up} margin-bottom:2cqh;
  }
  .s-section .sub { color:${section.textColor ?? c.dark}; font-size:${cqw(14)}; line-height:1.35; }

  /* ---------- Content (bullets / cards / table) ---------- */
  .s-content { background:${content.bg ?? c.bg ?? '#fff'}; background-size:cover; background-position:center; }
  .s-content .s-bg-dark, .s-final .s-bg-dark { position:absolute; inset:0; }
  .s-content .hd {
    position:absolute; left:4.45cqw; top:4.45cqw; right:4.45cqw;
    font-family:"${f.title}", Arial Black, sans-serif; font-size:${headerSize}cqw; line-height:1.2; ${up}
  }
  .s-content .hd .l1 { color:${content.accentColor ?? c.accent}; }
  .s-content .hd .l2 { color:${content.textColor ?? c.dark}; }
  .s-content .body-bullets { position:absolute; left:4.45cqw; top:24cqh; right:4.45cqw; }
  .s-content .bullet { display:flex; gap:1.2cqw; margin-bottom:2.2cqh; align-items:flex-start; }
  .s-content .bullet .mark {
    width:1.4cqw; height:1.4cqw; flex:0 0 auto; background:${bullets.marker ?? c.accent};
    margin-top:0.45cqh; border-radius:50%;
  }
  .s-content .bullet .bt { color:${bullets.textColor ?? c.dark}; font-size:${cqw(bodySize * 15)}; line-height:1.25; }
  .s-content .cards-grid { position:absolute; left:4.45cqw; top:24cqh; right:4.45cqw; bottom:10cqh;
    display:grid; grid-template-columns:repeat(${cards.columns ?? 2},1fr);
    grid-template-rows:repeat(${cards.rows ?? 2},1fr); gap:${(cards.gap ?? 0.35) * 12.8}cqw; }  .s-content .card {
    background:${cards.cardBg ?? c.light}; border:1px solid ${c.border}; padding:1.8cqw;
    border-top:0.45cqh solid ${cards.cardAccent ?? c.accent}; overflow:hidden;
  }
  .s-content .card .card-t {
    font-family:"${f.title}", Arial Black, sans-serif; color:${cards.cardAccent ?? c.accent};
    font-size:${cqw(16)}; margin-bottom:1cqh; ${up}
  }
  .s-content .card .card-b { color:${cards.textColor ?? c.dark}; font-size:${cqw(12)}; line-height:1.3; }
  .s-content table { border-collapse:collapse; width:100%; }
  .s-content .tbl-wrap { position:absolute; left:4.45cqw; top:24cqh; right:4.45cqw; }
  .s-content th {
    background:${table.headerFill ?? c.dark}; color:${table.headerText ?? c.white};
    font-family:"${f.title}", Arial Black, sans-serif; font-size:${cqw(12)}; text-align:left;
    padding:0.8cqw 0.9cqw;
  }
  .s-content td { padding:0.8cqw 0.9cqw; font-size:${cqw(12)}; color:${table.textColor ?? c.dark}; }
  .s-content tr:nth-child(odd) td { background:${table.altRowFill ?? c.light}; }
  .s-content td.hl {
    color:${c.accent}; font-family:"${f.title}", Arial Black, sans-serif; font-weight:bold;
  }

  /* ---------- Иллюстрация справа от текста ---------- */
  .s-content .ill {
    position:absolute; right:4.45cqw; top:24cqh; bottom:10cqh; width:42cqw;
    border-radius:4px; overflow:hidden; border:1px solid ${c.border};
  }
  .s-content .ill img { width:100%; height:100%; object-fit:cover; display:block; }
  .s-content.has-ill .body-bullets { right:48.5cqw; }
  .s-content.has-ill .tbl-wrap { right:48.5cqw; }
  .s-content.has-ill .cards-grid { right:48.5cqw; }

  /* ---------- Photo ---------- */
  .s-photo { background-color:${photo.bg ?? c.dark}; background-size:cover; background-position:center; }
  .s-photo .p-overlay { position:absolute; inset:0; background:${photo.overlay ?? 'rgba(16,20,30,.6)'}; }
  .s-photo .p-content { position:absolute; inset:0; z-index:1; }
  .s-photo .p-hd {
    position:absolute; left:4.45cqw; top:4.45cqw; right:4.45cqw;
    font-family:"${f.title}", Arial Black, sans-serif; font-size:${headerSize}cqw; line-height:1.2; ${up}
  }
  .s-photo .p-hd .l1 { color:${photo.accentColor ?? c.accentLight ?? '#ff4b55'}; }
  .s-photo .p-hd .l2 { color:${photo.textColor ?? c.white}; }
  .s-photo .p-body { position:absolute; left:4.45cqw; top:26cqh; right:4.45cqw; }
  .s-photo .bullet { display:flex; gap:1.2cqw; margin-bottom:2.2cqh; align-items:flex-start; }
  .s-photo .bullet .mark { width:1.4cqw; height:1.4cqw; flex:0 0 auto; background:${c.accent};
    margin-top:0.45cqh; border-radius:50%; }
  .s-photo .bullet .bt { color:${photo.textColor ?? c.white}; font-size:${cqw(bodySize * 15)}; line-height:1.25; }

  /* ---------- Final ---------- */
  .s-final { background:${final.bg ?? c.dark}; background-size:cover; background-position:center; position:relative; text-align:center; }
  ${(() => {
    const blockPos = final.pos?.block;
    const blockCss = blockPos
      ? posCss(blockPos, [['left', '4.45cqw'], ['right', '4.45cqw'], ['top', '50%']])
      : 'left:4.45cqw;right:4.45cqw;top:50%;transform:translateY(-50%);';
    return `.fin-block { position:absolute; display:flex; flex-direction:column; align-items:center; ${blockCss} }`;
  })()}
  .s-final .fin-center {
    font-family:"${f.title}", Arial Black, sans-serif; color:${final.centerText ?? c.white};
    font-size:${headerSize + 1}cqw; ${up} letter-spacing:.04em;
  }
  .s-final .fin-line { width:7cqw; height:0.4cqh; background:${c.accent}; margin:3cqh auto; }
  .s-final .fin-speaker { color:rgba(255,255,255,.85); font-size:${cqw(14)}; }
  .s-final .fin-qr { margin-top:2.5cqh; }
  .s-final .fin-qr img { width:${cqw(150)}; height:${cqw(150)}; border-radius:4px; display:block; margin:0 auto; }
  .s-final .fin-slogan { position:absolute; ${posCss(final.pos?.slogan, [['left', '4.45cqw'], ['bottom', '3.9cqh']])}; color:rgba(255,255,255,.6);
    font-size:${cqw(13)}; letter-spacing:.06em; ${up} }

  @media print {
    @page { size:13.333in 7.5in !important; margin:0 !important; }
    * { -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
    html, body { margin:0 !important; padding:0 !important; background:#fff !important; }
    .toolbar { display:none !important; }
    .progress { display:none !important; }
    .deck { max-width:none !important; padding:0 !important; margin:0 !important; }
    .deck.mode-slides { position:static !important; display:block !important; background:#fff !important; }
    .deck.mode-slides .slide, .slide {
      display:block !important; position:static !important; margin:0 !important; padding:0 !important;
      opacity:1 !important; visibility:visible !important; pointer-events:auto !important;
      width:100% !important; height:100vh !important; aspect-ratio:auto !important; transform:none !important;
    }
    .slide { break-after:page; page-break-after:always; }
    .slide:last-child { break-after:auto; page-break-after:auto; }
  }
  `;
}

interface RenderMeta {
  title?: string;
  date?: string;
  presenter?: string;
  qrDataUri?: string;
  illustrations?: Record<string, string>;
  /** cover/contain по каждому изображению — ключ 'bg:title'/'bg:{index}' для
   *  фоновых картинок, сам URL для иллюстраций (illustrations). Нет записи —
   *  используется дефолт 'contain' (см. bgImageStyle). */
  imageFit?: Record<string, 'cover' | 'contain'>;
  bgDarken?: Record<string, number>;
  slideIntervalSeconds?: number;
  slideTransition?: 'fade' | 'slide' | 'none';
  slideLoop?: boolean;
  showProgress?: boolean;
}

function renderSlide(
  slide: PresentationSlide,
  index: number,
  _total: number,
  tpl: PresentationTemplate,
  images: Record<string, string>,
  meta?: RenderMeta,
): string {
  const f = tpl.fonts;
  const presTitle = meta?.title || '';
  const presDate = meta?.date || '';
  const footer = (slide.footer || tpl.footerText || '')
    .replace(/дата/g, presDate || 'дата')
    .replace(/название доклада/g, presTitle || 'название доклада')
    .replace(/название/g, presTitle || 'название');
  const footHtml = footer
    ? `<div class="foot"><span class="mark"></span>${escapeHtml(footer).replace('№', `${index + 1}`)}</div>`
    : '';
  const hd = slide.heading1 || slide.heading2
    ? `<div class="hd"><span class="l1">${escapeHtml(upper(slide.heading1, f.uppercase ?? true))}</span>${slide.heading2 ? `<br><span class="l2">${escapeHtml(upper(slide.heading2, f.uppercase ?? true))}</span>` : ''}</div>`
    : '';
  const illUri = resolveIllustration(slide.imagePath, meta?.illustrations || {});
  const illFit = illUri ? (meta?.imageFit?.[illUri] ?? 'contain') : 'contain';
  const illHtml = illUri
    ? `<div class="ill"><img src="${illUri}" alt="" style="object-fit:${illFit};${illFit === 'contain' ? 'background:#fff;' : ''}"></div>`
    : '';
  const illCls = illUri ? ' has-ill' : '';

  switch (slide.layout) {
    case 'title': {
      const title: TemplateTitleLayout = tpl.layouts.title ?? ({} as TemplateTitleLayout);
      const bgUri = images['bg:title'];
      const gradient = title.bgStyle === 'gradient' && title.gradient ? title.gradient : '';
      const overlay = bgUri && gradient ? gradient.replace(/rgba\(16,20,30,(\.\d+|0)\)/g, 'rgba(16,20,30,.25)') : gradient;
      const titleDarken = meta?.bgDarken?.['bg:title'] ?? title.overlayOpacity;
      const titleFit = meta?.imageFit?.['bg:title'] ?? 'contain';
      return `<div class="slide s-title">
        ${bgUri ? `<div class="t-img" style="${bgImageStyle(bgUri, titleFit)}"></div>` : ''}
        ${overlay ? `<div class="t-overlay" style="background:${overlay};"></div>` : ''}
        ${titleDarken !== undefined ? `<div class="t-overlay" style="background:rgba(0,0,0,${titleDarken});"></div>` : ''}
        ${title.brand ? `<div class="t-brand">${escapeHtml(title.brand)}</div>` : ''}
        ${title.slogan ? `<div class="t-slogan">${escapeHtml(title.slogan)}</div>` : ''}
        ${title.kicker || slide.subtitle ? `<div class="t-kicker">${escapeHtml(title.kicker || slide.subtitle)}</div>` : ''}
        <div class="t-title">${escapeHtml(upper(slide.heading1 || slide.heading2 || slide.subtitle || '', true))}</div>
        <div class="t-line"></div>
        ${slide.speaker ? `<div class="t-speaker">${escapeHtml(slide.speaker)}</div>` : ''}
        ${footHtml}
      </div>`;
    }
    case 'section': {
      const bgUri = images[`bg:${index}`];
      const heading = upper(slide.heading1 || slide.subtitle || '', f.uppercase ?? true);
      const secDarken = meta?.bgDarken?.[`bg:${index}`];
      const secFit = meta?.imageFit?.[`bg:${index}`] ?? 'contain';
      const secImgStyle = bgUri
        ? (secDarken !== undefined
          ? `background-image:linear-gradient(rgba(0,0,0,${secDarken}),rgba(0,0,0,${secDarken})),url('${bgUri}');background-size:${secFit};background-repeat:no-repeat;background-position:center;`
          : bgImageStyle(bgUri, secFit))
        : '';
      return `<div class="slide s-section">
        ${secImgStyle ? `<div class="sec-img" style="${secImgStyle}"></div>` : `<div class="sec-img"></div>`}
        <div class="sec-txt">
          <div class="h1">${escapeHtml(heading)}</div>
          ${slide.heading2 ? `<div class="sub">${escapeHtml(slide.heading2)}</div>` : ''}
        </div>
        ${footHtml}
      </div>`;
    }
    case 'bullets': {
      const bulletsHtml = (slide.bullets || []).map(b =>
        `<div class="bullet"><span class="mark"></span><span class="bt">${escapeHtml(b)}</span></div>`).join('');
      const bgUri = images[`bg:${index}`];
      const darken = meta?.bgDarken?.[`bg:${index}`];
      const fit = meta?.imageFit?.[`bg:${index}`] ?? 'contain';
      return `<div class="slide s-content${illCls}" ${bgUri ? `style="${bgImageStyle(bgUri, fit)}"` : ''}>
        ${darken !== undefined && bgUri ? `<div class="s-bg-dark" style="background:rgba(0,0,0,${darken});"></div>` : ''}
        ${hd}
        <div class="body-bullets">${bulletsHtml}</div>
        ${illHtml}
        ${footHtml}
      </div>`;
    }
    case 'cards': {
      const cardsHtml = (slide.cards || []).map(card =>
        `<div class="card"><div class="card-t">${escapeHtml(upper(card.title, f.uppercase ?? true))}</div><div class="card-b">${escapeHtml(card.body)}</div></div>`).join('');
      const n = slide.cards?.length ?? 0;
      const gridCols = n <= 3 ? Math.max(1, n) : (n <= 4 ? 2 : 3);
      const gridRows = Math.max(1, Math.ceil(n / gridCols));
      const gridStyle = `grid-template-columns:repeat(${gridCols},1fr);grid-template-rows:repeat(${gridRows},1fr);`;
      const bgUri = images[`bg:${index}`];
      const darken = meta?.bgDarken?.[`bg:${index}`];
      const fit = meta?.imageFit?.[`bg:${index}`] ?? 'contain';
      return `<div class="slide s-content${illCls}" ${bgUri ? `style="${bgImageStyle(bgUri, fit)}"` : ''}>
        ${darken !== undefined && bgUri ? `<div class="s-bg-dark" style="background:rgba(0,0,0,${darken});"></div>` : ''}
        ${hd}
        <div class="cards-grid" style="${gridStyle}">${cardsHtml}</div>
        ${illHtml}
        ${footHtml}
      </div>`;
    }
    case 'table': {
      const t = slide.table;
      if (!t) return '';
      const highlightIdx = tpl.layouts.table?.highlightColumn ?? 1;
      const head = t.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
      const rows = t.rows.map(row =>
        `<tr>${row.map((cell, ci) => `<td${ci === highlightIdx ? ' class="hl"' : ''}>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
      const bgUri = images[`bg:${index}`];
      const darken = meta?.bgDarken?.[`bg:${index}`];
      const fit = meta?.imageFit?.[`bg:${index}`] ?? 'contain';
      return `<div class="slide s-content${illCls}" ${bgUri ? `style="${bgImageStyle(bgUri, fit)}"` : ''}>
        ${darken !== undefined && bgUri ? `<div class="s-bg-dark" style="background:rgba(0,0,0,${darken});"></div>` : ''}
        ${hd}
        <div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
        ${illHtml}
        ${footHtml}
      </div>`;
    }
    case 'photo': {
      const bgUri = images[`bg:${index}`];
      const photo: TemplatePhotoLayout = tpl.layouts.photo ?? {};
      const bulletsHtml = (slide.bullets || []).map(b =>
        `<div class="bullet"><span class="mark"></span><span class="bt">${escapeHtml(b)}</span></div>`).join('');
      const phead = slide.heading1 || slide.heading2
        ? `<div class="p-hd"><span class="l1">${escapeHtml(upper(slide.heading1, f.uppercase ?? true))}</span>${slide.heading2 ? `<br><span class="l2">${escapeHtml(upper(slide.heading2, f.uppercase ?? true))}</span>` : ''}</div>`
        : '';
      const photoDarken = meta?.bgDarken?.[`bg:${index}`];
      const overlayBg = photoDarken !== undefined ? `rgba(0,0,0,${photoDarken})` : (photo.overlay ?? 'rgba(16,20,30,.6)');
      const overlayHtml = bgUri ? `<div class="p-overlay" style="background:${overlayBg};"></div>` : '';
      const photoFit = meta?.imageFit?.[`bg:${index}`] ?? 'contain';
      return `<div class="slide s-photo" ${bgUri ? `style="${bgImageStyle(bgUri, photoFit)}"` : ''}>
        ${overlayHtml}
        <div class="p-content">
          ${phead}
          ${bulletsHtml ? `<div class="p-body">${bulletsHtml}</div>` : ''}
          ${footHtml}
        </div>
      </div>`;
    }
    case 'final': {
      const slogan = tpl.layouts.title?.slogan;
      const speakerName = slide.speaker || meta?.presenter || '';
      const qrHtml = meta?.qrDataUri
        ? `<div class="fin-qr"><img src="${meta.qrDataUri}" alt="QR-код контакта"></div>`
        : '';
      const bgUri = images[`bg:${index}`];
      const darken = meta?.bgDarken?.[`bg:${index}`];
      const finFit = meta?.imageFit?.[`bg:${index}`] ?? 'contain';
      return `<div class="slide s-final" ${bgUri ? `style="${bgImageStyle(bgUri, finFit)}"` : ''}>
        ${darken !== undefined && bgUri ? `<div class="s-bg-dark" style="background:rgba(0,0,0,${darken});"></div>` : ''}
        <div class="fin-block">
          <div class="fin-center">${escapeHtml(upper('Спасибо за внимание', true))}</div>
          <div class="fin-line"></div>
          ${speakerName ? `<div class="fin-speaker">${escapeHtml(speakerName)}</div>` : ''}
          ${qrHtml}
        </div>
        ${slogan ? `<div class="fin-slogan">${escapeHtml(slogan)}</div>` : ''}
        ${footHtml}
      </div>`;
    }
    default:
      return '';
  }
}

const DECK_SCRIPT = `
(function(){
  var deck=document.querySelector('.deck');
  var slides=[].slice.call(deck.querySelectorAll('.slide'));
  var bar=document.querySelector('.progress .bar');
  var cur=0;
  var timer=null;
  var auto=false;
  var interval=parseFloat(deck.getAttribute('data-interval')||'0');
  var loop=deck.getAttribute('data-loop')==='true';
  function clearStates(){
    slides.forEach(function(s){s.classList.remove('current','slide-in-left','slide-in-right','slide-out-left','slide-out-right');});
  }
  function updateProgress(){
    if(!bar) return;
    bar.style.width=((cur+1)/slides.length*100)+'%';
  }
  function resetAuto(){
    if(!auto||interval<=0) return;
    clearInterval(timer);
    timer=setInterval(function(){nav(1);}, interval*1000);
  }
  function startAuto(){
    if(interval<=0) return;
    auto=true; resetAuto();
    var b=document.querySelector('.toolbar .auto-btn');
    if(b) b.textContent='⏸ Стоп';
  }
  function stopAuto(){
    auto=false; clearInterval(timer);
    var b=document.querySelector('.toolbar .auto-btn');
    if(b) b.textContent='▶ Авто';
  }
  function toggleAuto(){ auto?stopAuto():startAuto(); }
  function nav(dir){
    var len=slides.length;
    var ni=loop ? (cur+dir+len)%len : Math.max(0,Math.min(len-1,cur+dir));
    if(ni===cur) return;
    clearStates();
    var out=slides[cur], inc=slides[ni];
    cur=ni;
    var inCls = dir<0 ? 'slide-in-left' : 'slide-in-right';
    var outCls = dir<0 ? 'slide-out-right' : 'slide-out-left';
    inc.classList.add(inCls);
    void inc.offsetWidth;
    inc.classList.add('current');
    inc.classList.remove(inCls);
    out.classList.add(outCls);
    requestAnimationFrame(function(){
      if(!loop && cur >= len-1 && dir>0){ stopAuto(); } else { resetAuto(); }
    });
    updateProgress();
  }
  function show(i){
    cur=Math.max(0,Math.min(slides.length-1,i));
    clearStates();
    slides[cur].classList.add('current');
    updateProgress();
    resetAuto();
  }
  function setMode(m){
    var slidesMode = m==='slides';
    deck.classList.toggle('mode-slides', slidesMode);
    if(slidesMode){
      if(!deck.querySelector('.slide.current')) show(0);
      updateProgress();
      startAuto();
    } else {
      stopAuto();
    }
  }
  function toggleFullscreen(){
    if(document.fullscreenElement){ (document.exitFullscreen||function(){}).call(document); }
    else {
      var el=document.documentElement;
      (el.requestFullscreen||el.webkitRequestFullscreen||function(){}).call(el);
    }
  }
  window.__setMode=setMode;
  window.__toggleFullscreen=toggleFullscreen;
  window.__toggleAuto=toggleAuto;
  window.__nav={next:function(){nav(1);},prev:function(){nav(-1);}};
  window.addEventListener('keydown',function(e){
    if(e.key==='f'||e.key==='F'||e.key==='а'||e.key==='А'){ toggleFullscreen(); return; }
    if(!deck.classList.contains('mode-slides')) return;
    if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key==='PageDown'||e.key===' '){e.preventDefault();nav(1);}
    else if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();nav(-1);}
    else if(e.key==='Home'){show(0);}
    else if(e.key==='End'){show(slides.length-1);}
  });
  window.addEventListener('touchstart',function(e){window.__tx=e.touches[0].clientX;},{passive:true});
  window.addEventListener('touchend',function(e){
    if(!deck.classList.contains('mode-slides')) return;
    var dx=e.changedTouches[0].clientX-(window.__tx||0);
    if(Math.abs(dx)>40) nav(dx<0?1:-1);
  });
  window.addEventListener('click',function(e){
    if(!deck.classList.contains('mode-slides')) return;
    if(e.target&&e.target.closest){ if(e.target.closest('.toolbar')) return; if(e.target.closest('a,button')) return; }
    nav(1);
  });
  window.addEventListener('contextmenu',function(e){
    if(!deck.classList.contains('mode-slides')) return;
    e.preventDefault();
    nav(-1);
  });
})();
`;

function renderPresentationHtml(
  generation: PresentationGeneration,
  tpl: PresentationTemplate,
  images: Record<string, string>,
  meta?: RenderMeta,
): string {
  const total = generation.slides.length;
  const slidesHtml = generation.slides.map((s, i) => renderSlide(s, i, total, tpl, images, meta)).join('\n');
  const title = escapeHtml(generation.title || 'Презентация');
  const interval = meta?.slideIntervalSeconds ?? tpl.slideIntervalSeconds ?? 0;
  const transition = meta?.slideTransition ?? tpl.slideTransition ?? 'fade';
  const loop = meta?.slideLoop ?? tpl.slideLoop ?? false;
  const showProgress = meta?.showProgress ?? true;
  const css = buildCss(tpl, transition, showProgress);
  const printBtn = `<button onclick="window.print()">🖨 Печать / PDF</button>`;
  const landingBtn = `<button onclick="window.__setMode('landing')">Лендинг</button>`;
  const slidesBtn = `<button onclick="window.__setMode('slides')">Слайды</button>`;
  const fullBtn = `<button onclick="window.__toggleFullscreen()">⛶ Экран</button>`;
  const autoBtn = interval > 0 ? `<button class="auto-btn" onclick="window.__toggleAuto()">▶ Авто</button>` : '';
  const prevBtn = `<button onclick="window.__nav.prev()">◀</button>`;
  const nextBtn = `<button onclick="window.__nav.next()">▶</button>`;
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<div class="toolbar">${landingBtn}${slidesBtn}${prevBtn}${nextBtn}${fullBtn}${autoBtn}${printBtn}</div>
<div class="deck mode-landing" data-interval="${interval}" data-loop="${loop ? 'true' : 'false'}">
${slidesHtml}
</div>
<div class="progress"><div class="bar"></div></div>
<script>
${DECK_SCRIPT}
</script>
</body>
</html>`;
}

/** Точка входа для веб-агента: строит self-contained HTML презентации.
 *  images — обычные HTTPS-ссылки (Фотобанк/create_png), не пути в вольте —
 *  резолвить в data URI не нужно (в отличие от Obsidian-версии). QR-код
 *  докладчика генерируется здесь же, если задан телефон/email. */
export async function buildWebPresentationHtml(
  generation: PresentationGeneration,
  tpl: PresentationTemplate,
  images: Record<string, string>,
  opts: {
    date?: string;
    presenter?: string;
    presenterPhone?: string;
    presenterEmail?: string;
    illustrations?: Record<string, string>;
    imageFit?: Record<string, 'cover' | 'contain'>;
  } = {},
): Promise<string> {
  let qrDataUri: string | undefined;
  const vcard = buildVCard(opts.presenter, opts.presenterPhone, opts.presenterEmail);
  if (vcard) {
    try {
      const QRCode = (await import('qrcode')).default;
      qrDataUri = await QRCode.toDataURL(vcard, { width: 250, margin: 2, color: { dark: '#FF0000', light: '#FFFFFF' } });
    } catch {
      // QR необязателен — молча пропускаем
    }
  }
  return renderPresentationHtml(generation, tpl, images, {
    title: generation.title,
    date: opts.date,
    presenter: opts.presenter,
    qrDataUri,
    illustrations: opts.illustrations,
    imageFit: opts.imageFit,
  });
}
