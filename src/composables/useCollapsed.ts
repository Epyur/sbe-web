import { ref } from 'vue';

/** Состояние «свёрнут/развёрнут» для сайдбара, персистентное per-viewer
 * (localStorage) — как сворачивание боковых панелей в Obsidian-плагинах. */
export function useCollapsed(storageKey: string) {
  const collapsed = ref(localStorage.getItem(storageKey) === '1');

  function toggle(): void {
    collapsed.value = !collapsed.value;
    try {
      localStorage.setItem(storageKey, collapsed.value ? '1' : '0');
    } catch {
      // localStorage недоступен — сворачивание не переживёт перезагрузку.
    }
  }

  return { collapsed, toggle };
}
