/** Встроенный шаблон презентации + дизайн-скил — порт BUILTIN_TEMPLATES[0]
 *  ('technonicol') и DEFAULT_DESIGN_RULES из sbe-presentations/src/services/
 *  presentation-templates.ts (данные, без Obsidian-зависимостей). Веб-агент
 *  пока поддерживает только этот один встроенный шаблон — без загрузки
 *  пользовательских JSON-шаблонов из вольта (не нужно вне Obsidian). */

import type { PresentationTemplate } from './presentationTypes';

export const DEFAULT_PRESENTATION_TEMPLATE: PresentationTemplate = {
  id: 'technonicol',
  name: 'Технониколь',
  canvas: { w: 960, h: 540 },
  colors: {
    accent: '#E30613',
    accentLight: '#FF6B73',
    dark: '#242E40',
    gray: '#59606D',
    light: '#ECEEF1',
    border: '#BABFC7',
    white: '#FFFFFF',
    onDark: '#FFFFFF',
    bg: '#FFFFFF',
  },
  fonts: {
    title: 'Arial Black',
    body: 'Arial',
    uppercase: true,
    titleSize: 2.7,
    bodySize: 1.05,
  },
  footerText: 'дата · название доклада · №',
  slideTransition: 'fade',
  slideIntervalSeconds: 0,
  slideLoop: false,
  layouts: {
    title: {
      bgStyle: 'gradient',
      bg: '#242E40',
      gradient: 'linear-gradient(100deg, rgba(16,20,30,.94) 0%, rgba(16,20,30,.18) 60%, rgba(16,20,30,0) 100%)',
      brand: 'ТЕХНОНИКОЛЬ',
      brandColor: '#FFFFFF',
      slogan: 'Знание. Опыт. Мастерство.',
      sloganColor: '#FFFFFF',
      kickerColor: '#E30613',
      titleColor: '#FFFFFF',
      titleSize: 3.4,
      speakerColor: '#FFFFFF',
    },
    section: { bg: '#FFFFFF', textColor: '#242E40', accentColor: '#E30613' },
    content: { bg: '#FFFFFF', textColor: '#242E40', accentColor: '#E30613' },
    bullets: { marker: '#E30613', textColor: '#242E40' },
    cards: { columns: 2, rows: 2, gap: 0.35, cardBg: '#ECEEF1', cardAccent: '#E30613', textColor: '#242E40' },
    table: { headerFill: '#242E40', headerText: '#FFFFFF', altRowFill: '#ECEEF1', highlightColumn: 1, textColor: '#242E40' },
    photo: {
      overlay: 'linear-gradient(100deg, rgba(16,20,30,.94) 0%, rgba(16,20,30,.18) 60%, rgba(16,20,30,0) 100%)',
      textColor: '#FFFFFF',
    },
    final: { bg: '#242E40', centerText: '#FFFFFF' },
  },
};

/** Дизайн-скил презентаций — те же принципы, что уже используются в
 *  Obsidian-плагине sbe-presentations (DEFAULT_DESIGN_RULES), встроены прямо
 *  в описание тула create_presentation, а не через list_skills/read_skill —
 *  тот глобальный скил ("presentation-creator") оказался про другой формат
 *  (React/Vite/Recharts со стилем Sentry), не про наши презентации. */
export const PRESENTATION_DESIGN_RULES = `## Универсальная структура презентации
1. Hook — почему аудитории должно быть важно? (проблема, данные, история)
2. Context — что им нужно знать? (фон, ограничения)
3. Journey — как вы пришли сюда? (процесс, ключевые моменты)
4. Solution — что вы предлагаете? (решение, с обоснованием)
5. Evidence — почему это правильно? (данные, результаты)
6. Ask — что нужно от аудитории? (одобрение, фидбэк, ресурсы)

## Принципы слайдов
- Одна идея на слайд. «Покажи, а не расскажи» — визуал вместо текста, где возможно.
- Дизайн «для заднего ряда»: крупный текст, высокая контрастность.
- Заголовки короткие (до ~8 слов на строку) — верхний регистр применяет сам шаблон, не нужно писать заглавными самому.
- Каждый слайд — максимум 5-6 пунктов, по одной строке.
- Тон — деловой, без канцелярита, без выдуманных фактов; если данных мало — формулируй осторожно.
- Презентация ВСЕГДА заканчивается слайдом layout:"final" (шаблон сам добавит фразу «Спасибо за внимание» — не пиши её в heading).`;
