/** Типы формата презентаций — порт sbe-presentations/src/types/presentations.ts
 *  (только то, что нужно для рендера: без PresentationQuestionaire/PresentationItem/
 *  PresentationDraft — те завязаны на хранение в вольте Obsidian, здесь презентация
 *  эфемерна: агент формирует HTML одним вызовом, не хранит черновики). */

export interface TemplateCanvas {
  w: number;
  h: number;
}

export interface TemplateColors {
  accent: string;
  accentLight?: string;
  dark: string;
  gray: string;
  light: string;
  border: string;
  white: string;
  onDark: string;
  bg?: string;
}

export interface TemplateFonts {
  title: string;
  body: string;
  uppercase?: boolean;
  titleSize?: number;
  bodySize?: number;
}

export type AlignPreset =
  | 'top-left' | 'top-center' | 'top-right'
  | 'center-left' | 'center' | 'center-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface ElementPos {
  align?: AlignPreset;
  left?: number | string;
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
}

export interface TemplateTitlePos {
  brand?: ElementPos;
  slogan?: ElementPos;
  kicker?: ElementPos;
  title?: ElementPos;
  line?: ElementPos;
  speaker?: ElementPos;
}

export interface TemplateTitleLayout {
  bgStyle: 'gradient' | 'solid' | 'image' | 'none';
  bg?: string;
  gradient?: string;
  imageScale?: number;
  brand?: string;
  brandColor?: string;
  slogan?: string;
  sloganColor?: string;
  kicker?: string;
  kickerColor?: string;
  titleColor?: string;
  titleSize?: number;
  speakerColor?: string;
  overlayOpacity?: number;
  pos?: TemplateTitlePos;
}

export interface TemplateLayout {
  bg?: string;
  textColor?: string;
  accentColor?: string;
  marker?: string;
}

export interface TemplateCardsLayout extends TemplateLayout {
  columns?: number;
  rows?: number;
  gap?: number;
  cardBg?: string;
  cardAccent?: string;
}

export interface TemplateTableLayout extends TemplateLayout {
  headerFill?: string;
  headerText?: string;
  altRowFill?: string;
  highlightColumn?: number;
}

export interface TemplatePhotoLayout extends TemplateLayout {
  overlay?: string;
  overlayGradient?: string;
  overlayOpacity?: number;
}

export interface TemplateFinalLayout extends TemplateLayout {
  bg?: string;
  centerText?: string;
  pos?: {
    block?: ElementPos;
    slogan?: ElementPos;
  };
}

export interface PresentationTemplateLayouts {
  title?: TemplateTitleLayout;
  section?: TemplateLayout;
  content?: TemplateLayout;
  bullets?: TemplateLayout;
  cards?: TemplateCardsLayout;
  table?: TemplateTableLayout;
  photo?: TemplatePhotoLayout;
  final?: TemplateFinalLayout;
}

export interface PresentationTemplate {
  id: string;
  name: string;
  canvas: TemplateCanvas;
  colors: TemplateColors;
  fonts: TemplateFonts;
  footerText?: string;
  slideIntervalSeconds?: number;
  slideTransition?: 'fade' | 'slide' | 'none';
  slideLoop?: boolean;
  layouts: PresentationTemplateLayouts;
}

export interface PresentationSlide {
  layout: 'title' | 'section' | 'bullets' | 'cards' | 'table' | 'photo' | 'final';
  heading1?: string;
  heading2?: string;
  subtitle?: string;
  bullets?: string[];
  cards?: Array<{ title: string; body: string; accent?: 'accent' | 'dark' }>;
  table?: { headers: string[]; rows: string[][] };
  speaker?: string;
  footer?: string;
  imagePath?: string;
}

export interface PresentationGeneration {
  title: string;
  slides: PresentationSlide[];
}
