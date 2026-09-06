<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as llmApi from '../api/llmApi';
import * as yougileApi from '../api/yougileApi';
import { errorMessage } from '../api/http';

const configured = ref(false);
const apiKey = ref('');
const apiUrl = ref('');
const error = ref('');
const notice = ref('');
const loading = ref(true);
const busy = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const status = await llmApi.getStatus();
    configured.value = status.configured;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ================= ЮГайл =================
const yougileConnected = ref(false);
const yougilePassword = ref('');
const yougileError = ref('');
const yougileNotice = ref('');
const yougileLoading = ref(true);
const yougileBusy = ref(false);

async function loadYougile(): Promise<void> {
  yougileLoading.value = true;
  try {
    const status = await yougileApi.getStatus();
    yougileConnected.value = status.connected;
  } catch (e: unknown) {
    yougileError.value = errorMessage(e);
  } finally {
    yougileLoading.value = false;
  }
}
onMounted(loadYougile);

async function saveYougile(): Promise<void> {
  if (!yougilePassword.value.trim()) {
    yougileError.value = 'Введите пароль';
    return;
  }
  yougileBusy.value = true;
  yougileError.value = '';
  yougileNotice.value = '';
  try {
    await yougileApi.setPassword(yougilePassword.value.trim());
    yougilePassword.value = '';
    yougileNotice.value = 'Пароль сохранён на сервере';
    await loadYougile();
  } catch (e: unknown) {
    yougileError.value = errorMessage(e);
  } finally {
    yougileBusy.value = false;
  }
}

async function removeYougile(): Promise<void> {
  yougileBusy.value = true;
  yougileError.value = '';
  yougileNotice.value = '';
  try {
    await yougileApi.deletePassword();
    yougileNotice.value = 'Пароль удалён';
    await loadYougile();
  } catch (e: unknown) {
    yougileError.value = errorMessage(e);
  } finally {
    yougileBusy.value = false;
  }
}

async function save(): Promise<void> {
  if (!apiKey.value.trim()) {
    error.value = 'Введите ключ';
    return;
  }
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await llmApi.setApiKey(apiKey.value.trim(), apiUrl.value.trim());
    apiKey.value = '';
    notice.value = 'Ключ сохранён на сервере';
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await llmApi.deleteApiKey();
    notice.value = 'Ключ удалён';
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="sw-card" style="max-width: 480px; padding: 24px">
    <h2>ИИ</h2>
    <p class="sw-hint">
      Ваш личный ключ провайдера ИИ (например, chadgpt.ru) — шифруется и хранится на сервере,
      привязан к вашей почте. Один раз настроенный здесь ключ автоматически доступен во всех
      плагинах и в веб-версии.
    </p>

    <p v-if="loading" class="sw-hint">Загрузка…</p>
    <template v-else>
      <p class="sw-hint">Состояние: {{ configured ? 'ключ настроен' : 'ключ не задан' }}</p>

      <div class="sw-field">
        <label>API-ключ провайдера</label>
        <input v-model="apiKey" class="sw-input" type="password" placeholder="chad-..." :disabled="busy" />
      </div>
      <div class="sw-field">
        <label>Адрес провайдера (необязательно)</label>
        <input v-model="apiUrl" class="sw-input" placeholder="https://ask.chadgpt.ru/api/v1/chat/completions" :disabled="busy" />
      </div>

      <p v-if="error" class="sw-error">{{ error }}</p>
      <p v-if="notice" class="sw-hint">{{ notice }}</p>

      <div class="sw-toolbar">
        <button class="sw-btn sw-btn--primary" type="button" :disabled="busy" @click="save">Сохранить</button>
        <button v-if="configured" class="sw-btn sw-btn--danger" type="button" :disabled="busy" @click="remove">Удалить ключ</button>
      </div>
    </template>
  </div>

  <div class="sw-card" style="max-width: 480px; padding: 24px; margin-top: 16px">
    <h2>ЮГайл</h2>
    <p class="sw-hint">
      Пароль от вашей учётной записи ЮГайла — шифруется и хранится на сервере,
      привязан к вашей почте (логин = ваш email в ЦУП). Нужен, чтобы агент LogicTEAM.007
      мог читать и создавать задачи, писать в чат задачи и менять её статус.
    </p>

    <p v-if="yougileLoading" class="sw-hint">Загрузка…</p>
    <template v-else>
      <p class="sw-hint">Состояние: {{ yougileConnected ? 'подключено' : 'не подключено' }}</p>

      <div class="sw-field">
        <label>Пароль ЮГайла</label>
        <input v-model="yougilePassword" class="sw-input" type="password" :disabled="yougileBusy" />
      </div>

      <p v-if="yougileError" class="sw-error">{{ yougileError }}</p>
      <p v-if="yougileNotice" class="sw-hint">{{ yougileNotice }}</p>

      <div class="sw-toolbar">
        <button class="sw-btn sw-btn--primary" type="button" :disabled="yougileBusy" @click="saveYougile">Сохранить</button>
        <button v-if="yougileConnected" class="sw-btn sw-btn--danger" type="button" :disabled="yougileBusy" @click="removeYougile">Отключить</button>
      </div>
    </template>
  </div>
</template>
