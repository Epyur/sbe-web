<script setup lang="ts">
import { ref, watch } from 'vue';
import * as photoApi from '../../api/photoApi';
import { getCachedThumb, putCachedThumb } from '../../api/photoThumbCache';
import type { PhotoItem } from '../../types/photobank';

// Blob-URL кладётся в общий `cache` (владеет им PhotobankView) и намеренно не
// освобождается здесь при размонтировании карточки — список тот же самый
// фото может быть перерисован при повторном поиске, повторная загрузка
// миниатюры того же файла того не стоит.
//
// shouldLoad (2026-09-05) — ленивая загрузка: карточка не грузит превью, пока
// PhotobankView не решит (через IntersectionObserver), что она в видимой
// области + следующие ~10 фото. См. AGENTS.md.
const props = defineProps<{ photo: PhotoItem; cache: Map<number, string>; shouldLoad: boolean }>();

const src = ref(props.cache.get(props.photo.id) ?? '');

async function load(): Promise<void> {
  const key = props.photo.thumb_key || props.photo.file_key;
  if (!key) return;
  const cached = props.cache.get(props.photo.id);
  if (cached) {
    src.value = cached;
    return;
  }
  // Персистентный кэш (IndexedDB, photoThumbCache.ts) — переживает
  // перезагрузку страницы. Сеть трогаем только если записи нет (первое
  // открытие/новое фото) или фото изменилось с тех пор (updated_at не
  // совпадает) — не при каждом открытии страницы.
  const persisted = await getCachedThumb(props.photo.id);
  if (persisted && persisted.updatedAt === props.photo.updated_at) {
    const url = URL.createObjectURL(persisted.blob);
    props.cache.set(props.photo.id, url);
    src.value = url;
    return;
  }
  try {
    const blob = await photoApi.fetchFileBlob(key, true);
    void putCachedThumb({ id: props.photo.id, updatedAt: props.photo.updated_at, blob });
    const url = URL.createObjectURL(blob);
    props.cache.set(props.photo.id, url);
    src.value = url;
  } catch {
    src.value = '';
  }
}

watch([() => props.photo.id, () => props.shouldLoad], ([, shouldLoad]) => {
  if (shouldLoad) void load();
}, { immediate: true });
</script>

<template>
  <img v-if="src" class="sw-photo-card__thumb" :src="src" alt="" loading="lazy" />
  <div v-else class="sw-photo-card__thumb" />
</template>
