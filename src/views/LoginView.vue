<script setup lang="ts">
import { ref } from 'vue';
import { requestLink } from '../api/authApi';
import { errorMessage } from '../api/http';

const email = ref('');
const sending = ref(false);
const sent = ref(false);
const error = ref('');

async function submit(): Promise<void> {
  error.value = '';
  const value = email.value.trim();
  if (!value) {
    error.value = 'Введите email';
    return;
  }
  sending.value = true;
  try {
    await requestLink(value);
    sent.value = true;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="sw-center-screen">
    <div class="sw-card sw-auth-card">
      <template v-if="!sent">
        <h1>LogicTEAM.WWW</h1>
        <p>Введите рабочую почту — придёт ссылка для входа, действует 5 минут.</p>
        <form @submit.prevent="submit">
          <div class="sw-field">
            <label for="email">Email</label>
            <input
              id="email"
              v-model="email"
              class="sw-input"
              type="email"
              placeholder="you@tn.ru"
              autocomplete="email"
              :disabled="sending"
            />
          </div>
          <button class="sw-btn sw-btn--primary" type="submit" style="width: 100%" :disabled="sending">
            {{ sending ? 'Отправляем…' : 'Прислать ссылку' }}
          </button>
          <p v-if="error" class="sw-error">{{ error }}</p>
        </form>
      </template>
      <template v-else>
        <h1>Письмо отправлено</h1>
        <p>Проверьте почту {{ email }} — ссылка действует 5 минут и работает один раз.</p>
        <button class="sw-btn" type="button" @click="sent = false">Отправить ещё раз</button>
      </template>
    </div>
  </div>
</template>
