<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { consumeLink } from '../api/authApi';
import { setSession } from '../store/session';
import { errorMessage } from '../api/http';

const route = useRoute();
const router = useRouter();
const error = ref('');

onMounted(async () => {
  const token = String(route.query.token ?? '');
  if (!token) {
    error.value = 'Ссылка неполная — токен отсутствует.';
    return;
  }
  try {
    const { email, deviceId, key } = await consumeLink(token);
    setSession({ email, deviceId, key });
    router.replace({ name: 'launcher' });
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
});
</script>

<template>
  <div class="sw-center-screen">
    <div class="sw-card sw-auth-card">
      <template v-if="!error">
        <h1>Входим…</h1>
        <p>Проверяем ссылку.</p>
      </template>
      <template v-else>
        <h1>Не удалось войти</h1>
        <p class="sw-error">{{ error }}</p>
        <RouterLink class="sw-btn sw-btn--primary" to="/login">Запросить новую ссылку</RouterLink>
      </template>
    </div>
  </div>
</template>
