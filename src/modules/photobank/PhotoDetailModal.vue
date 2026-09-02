<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import * as photoApi from '../../api/photoApi';
import { errorMessage } from '../../api/http';
import type { PhotoComment, PhotoItem } from '../../types/photobank';

const props = defineProps<{ photo: PhotoItem }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const imageUrl = ref('');
const comments = ref<PhotoComment[]>([]);
const newComment = ref('');
const liked = ref(false);
const favorited = ref(false);
const busy = ref(false);
const error = ref('');

let objectUrl = '';

async function loadImage(): Promise<void> {
  try {
    objectUrl = await photoApi.fetchFileBlobUrl(props.photo.file_key, true);
    imageUrl.value = objectUrl;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

async function loadComments(): Promise<void> {
  try {
    comments.value = await photoApi.listComments(props.photo.id);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

async function toggleLike(): Promise<void> {
  busy.value = true;
  try {
    liked.value = !liked.value;
    await photoApi.setLike(props.photo.id, liked.value);
    emit('changed');
  } catch (e: unknown) {
    liked.value = !liked.value;
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function toggleFavorite(): Promise<void> {
  busy.value = true;
  try {
    favorited.value = !favorited.value;
    await photoApi.setFavorite(props.photo.id, favorited.value);
  } catch (e: unknown) {
    favorited.value = !favorited.value;
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function submitComment(): Promise<void> {
  const text = newComment.value.trim();
  if (!text) return;
  busy.value = true;
  try {
    await photoApi.addComment(props.photo.id, text);
    newComment.value = '';
    await loadComments();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function downloadOriginal(): Promise<void> {
  try {
    const url = await photoApi.fetchFileBlobUrl(props.photo.file_key, false);
    const a = document.createElement('a');
    a.href = url;
    a.download = props.photo.file_name || 'photo';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return iso;
  }
}

watch(
  () => props.photo.id,
  () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    imageUrl.value = '';
    void loadImage();
    void loadComments();
    void photoApi.viewPhoto(props.photo.id).catch(() => undefined);
  },
  { immediate: true },
);

onMounted(() => {
  void loadImage();
  void loadComments();
  void photoApi.viewPhoto(props.photo.id).catch(() => undefined);
});

onUnmounted(() => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
</script>

<template>
  <div class="sw-modal-backdrop" @click.self="emit('close')">
    <div class="sw-modal">
      <button class="sw-btn sw-modal__close" type="button" @click="emit('close')">✕</button>
      <h2>{{ photo.title || photo.file_name }}</h2>
      <img v-if="imageUrl && photo.kind === 'image'" :src="imageUrl" alt="" style="max-width: 100%; border-radius: 8px" />
      <p v-if="photo.description">{{ photo.description }}</p>
      <p v-if="photo.tags.length" class="sw-hint">Теги: {{ photo.tags.join(', ') }}</p>
      <div class="sw-toolbar">
        <button class="sw-btn" type="button" :disabled="busy" @click="toggleLike">
          {{ liked ? '♥' : '♡' }} Нравится
        </button>
        <button class="sw-btn" type="button" :disabled="busy" @click="toggleFavorite">
          {{ favorited ? '⭐' : '☆' }} Избранное
        </button>
        <button class="sw-btn" type="button" @click="downloadOriginal">⬇ Скачать оригинал</button>
      </div>
      <p v-if="error" class="sw-error">{{ error }}</p>

      <div class="sw-section-title">Комментарии</div>
      <div v-if="!comments.length" class="sw-hint">Пока нет комментариев.</div>
      <div v-for="c in comments" :key="c.id" class="sw-comment">
        <span class="sw-comment__author">{{ c.author_email }}</span>
        <span class="sw-comment__date">{{ formatDate(c.created_at) }}</span>
        <div>{{ c.text }}</div>
      </div>
      <form class="sw-toolbar" style="margin-top: 12px" @submit.prevent="submitComment">
        <input v-model="newComment" class="sw-input" placeholder="Написать комментарий…" :disabled="busy" />
        <button class="sw-btn sw-btn--primary" type="submit" :disabled="busy">Отправить</button>
      </form>
    </div>
  </div>
</template>
