<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { hasAppAccess } from '../api/authApi';

const router = useRouter();
const checking = ref(true);
const photoAccess = ref(false);
const labAccess = ref(false);
const agentAccess = ref(false);

onMounted(async () => {
  const [photo, lab, agent] = await Promise.all([hasAppAccess('photo'), hasAppAccess('lab'), hasAppAccess('agent')]);
  photoAccess.value = photo;
  labAccess.value = lab;
  agentAccess.value = agent;
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
        :title="photoAccess ? 'Фотобанк' : 'Фотобанк — нет доступа'"
        @click="open('photobank', photoAccess)"
      >
        <img src="/covers/photo.png" alt="Фотобанк" class="sw-tile__cover" />
      </div>
      <div
        class="sw-card sw-tile"
        :aria-disabled="!labAccess"
        role="button"
        tabindex="0"
        :title="labAccess ? 'Заявки на испытания' : 'Заявки на испытания — нет доступа'"
        @click="open('requests', labAccess)"
      >
        <img src="/covers/lab.png" alt="Заявки на испытания" class="sw-tile__cover" />
      </div>
      <div
        class="sw-card sw-tile"
        :aria-disabled="!agentAccess"
        role="button"
        tabindex="0"
        :title="agentAccess ? 'LogicTEAM.007' : 'LogicTEAM.007 — нет доступа'"
        @click="open('agent', agentAccess)"
      >
        <img src="/covers/llm.png" alt="LogicTEAM.007" class="sw-tile__cover" />
      </div>
    </template>
  </div>
</template>
