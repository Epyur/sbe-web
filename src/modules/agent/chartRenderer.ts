/** Рендер графика агента в PNG через ApexCharts (браузер), не mermaid —
 *  mermaid xychart-beta физически не умеет ни легенду, ни подпись оси Y (см.
 *  docs/superpowers/specs/2026-09-06-web-agent-chart-rendering-design.md).
 *  Порт buildApexOptions из sbe-dashboards/src/services/chart-builder.ts,
 *  дополненный переключателем легенды (там она захардкожена включённой). */

import ApexCharts from 'apexcharts';
import type { ApexOptions } from 'apexcharts';

export type ChartRenderType = 'bar' | 'line' | 'donut' | 'pie' | 'area' | 'scatter';

export interface ChartRenderSeries {
  name: string;
  data: number[];
}

export interface ChartRenderSpec {
  chartType: ChartRenderType;
  title: string;
  categories: string[];
  series: ChartRenderSeries[];
  xLabel?: string;
  yLabel?: string;
  legend: boolean;
}

function buildApexOptions(spec: ChartRenderSpec): ApexOptions {
  const base: ApexOptions = {
    chart: { type: spec.chartType, height: 320, width: 560, background: '#ffffff', toolbar: { show: false }, animations: { enabled: false } },
    title: { text: spec.title, align: 'left' },
    colors: ['#e11b17', '#2f6fed', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'],
    legend: { show: spec.legend, position: 'bottom', fontSize: '12px' },
    stroke: { curve: 'smooth', width: 2 },
    grid: { strokeDashArray: 3 },
  };

  if (spec.chartType === 'donut' || spec.chartType === 'pie') {
    return {
      ...base,
      series: spec.series[0]?.data ?? [],
      labels: spec.categories,
      plotOptions: { pie: { donut: { size: '62%' } } },
    } as ApexOptions;
  }

  return {
    ...base,
    series: spec.series.map(s => ({ name: s.name, data: s.data })),
    xaxis: {
      categories: spec.categories,
      ...(spec.xLabel ? { title: { text: spec.xLabel } } : {}),
    },
    ...(spec.yLabel ? { yaxis: { title: { text: spec.yLabel } } } : {}),
  };
}

/** Рендерит спеку в PNG (data URL) через скрытый offscreen-контейнер —
 *  ApexCharts нужен реальный DOM-узел для измерения размеров при рендере. */
export async function renderChartToDataUrl(spec: ChartRenderSpec): Promise<string> {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '0';
  container.style.width = '560px';
  container.style.height = '320px';
  document.body.appendChild(container);

  const chart = new ApexCharts(container, buildApexOptions(spec));
  try {
    await chart.render();
    const result = await chart.dataURI();
    if ('imgURI' in result && result.imgURI) return result.imgURI;
    throw new Error('Не удалось получить изображение графика.');
  } finally {
    chart.destroy();
    container.remove();
  }
}

/** data:image/png;base64,... → Blob, для загрузки на сервер через FormData. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, base64] = dataUrl.split(',');
  const mimeMatch = meta.match(/data:(.*);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
