<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { hasAppAccess } from '../api/authApi';

const router = useRouter();
const checking = ref(true);
const photoAccess = ref(false);
const labAccess = ref(false);

onMounted(async () => {
  const [photo, lab] = await Promise.all([hasAppAccess('photo'), hasAppAccess('lab')]);
  photoAccess.value = photo;
  labAccess.value = lab;
  checking.value = false;
});

function open(name: string, allowed: boolean): void {
  if (!allowed) return;
  router.push({ name });
}
</script>

<template>
  <div class="sw-launcher">
    <template v-if="checking">
      <p class="sw-loading">Проверяем доступ…</p>
    </template>
    <template v-else>
      <div
        class="sw-card sw-tile"
        :aria-disabled="!photoAccess"
        role="button"
        tabindex="0"
        @click="open('photobank', photoAccess)"
      >
        <div class="sw-tile__icon">🖼️</div>
        <div class="sw-tile__title">Фотобанк</div>
        <div class="sw-tile__hint">{{ photoAccess ? 'Просмотр и поиск' : 'Нет доступа' }}</div>
      </div>
      <div
        class="sw-card sw-tile"
        :aria-disabled="!labAccess"
        role="button"
        tabindex="0"
        @click="open('requests', labAccess)"
      >
        <div class="sw-tile__icon">🧪</div>
        <div class="sw-tile__title">Заявки на испытания</div>
        <div class="sw-tile__hint">{{ labAccess ? 'Открыть' : 'Нет доступа' }}</div>
      </div>
    </template>
  </div>
</template>
