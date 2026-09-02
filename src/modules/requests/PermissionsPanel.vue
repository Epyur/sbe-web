<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as labApi from '../../api/labApi';
import { errorMessage } from '../../api/http';

const permissions = ref<Array<{ email: string; role: string }>>([]);
const commonAccess = ref('');
const newEmail = ref('');
const newRole = ref('viewer');
const error = ref('');
const busy = ref(false);

/** Без "Супер-администратор" — веб-сессия не может назначать эту роль (сервер
 * и так отклонит: channel=web клэмпит эффективную роль актора до admin), сам
 * пункт в форме тоже не показываем, чтобы не предлагать заведомо провальное действие. */
const ROLES = ['viewer', 'editor', 'admin'];

async function load(): Promise<void> {
  try {
    [permissions.value, commonAccess.value] = await Promise.all([
      labApi.listPermissions(),
      labApi.getCommonAccess(),
    ]);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}
onMounted(load);

async function setRole(email: string, role: string): Promise<void> {
  busy.value = true;
  try {
    await labApi.setPermission(email, role);
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function addPermission(): Promise<void> {
  if (!newEmail.value.trim()) return;
  await setRole(newEmail.value.trim(), newRole.value);
  newEmail.value = '';
}

async function revoke(email: string): Promise<void> {
  await setRole(email, '');
}

async function updateCommonAccess(level: string): Promise<void> {
  busy.value = true;
  try {
    await labApi.setCommonAccess(level);
    commonAccess.value = level;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <h2>Права доступа</h2>
    <p v-if="error" class="sw-error">{{ error }}</p>

    <div class="sw-field" style="max-width: 300px">
      <label>Общий доступ (по умолчанию)</label>
      <select class="sw-select" :value="commonAccess" :disabled="busy" @change="updateCommonAccess(($event.target as HTMLSelectElement).value)">
        <option value="">— Закрыт —</option>
        <option value="viewer">viewer</option>
        <option value="editor">editor</option>
      </select>
    </div>

    <table class="sw-table">
      <thead><tr><th>Email</th><th>Роль</th><th></th></tr></thead>
      <tbody>
        <tr v-for="p in permissions" :key="p.email">
          <td>{{ p.email }}</td>
          <td>
            <select class="sw-select" :value="p.role" :disabled="busy || p.role === 'superadmin'" @change="setRole(p.email, ($event.target as HTMLSelectElement).value)">
              <option v-if="p.role === 'superadmin'" value="superadmin">superadmin (не менять через веб)</option>
              <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
            </select>
          </td>
          <td><button class="sw-btn sw-btn--danger" type="button" :disabled="busy" @click="revoke(p.email)">Отозвать</button></td>
        </tr>
      </tbody>
    </table>

    <div class="sw-toolbar" style="margin-top: 16px">
      <input v-model="newEmail" class="sw-input" placeholder="email@tn.ru" style="max-width: 240px" />
      <select v-model="newRole" class="sw-select" style="max-width: 140px">
        <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
      </select>
      <button class="sw-btn sw-btn--primary" type="button" :disabled="busy" @click="addPermission">Назначить</button>
    </div>
  </div>
</template>
