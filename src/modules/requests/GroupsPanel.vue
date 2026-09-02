<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as labApi from '../../api/labApi';
import { errorMessage } from '../../api/http';
import type { LabGroup } from '../../types/requests';

const groups = ref<LabGroup[]>([]);
const newGroupName = ref('');
const newMemberEmail = ref<Record<number, string>>({});
const newMemberRole = ref<Record<number, string>>({});
const error = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  try {
    groups.value = await labApi.listGroups();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  }
}
onMounted(load);

async function createGroup(): Promise<void> {
  if (!newGroupName.value.trim()) return;
  busy.value = true;
  try {
    await labApi.createGroup(newGroupName.value.trim());
    newGroupName.value = '';
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function addMember(groupId: number): Promise<void> {
  const email = (newMemberEmail.value[groupId] ?? '').trim();
  if (!email) return;
  busy.value = true;
  try {
    await labApi.addGroupMember(groupId, email, newMemberRole.value[groupId] ?? 'viewer');
    newMemberEmail.value[groupId] = '';
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function removeMember(groupId: number, email: string): Promise<void> {
  busy.value = true;
  try {
    await labApi.removeGroupMember(groupId, email);
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <h2>Группы</h2>
    <p v-if="error" class="sw-error">{{ error }}</p>
    <div class="sw-toolbar">
      <input v-model="newGroupName" class="sw-input" placeholder="Название новой группы" />
      <button class="sw-btn sw-btn--primary" type="button" :disabled="busy" @click="createGroup">Создать</button>
    </div>
    <div v-for="g in groups" :key="g.id" class="sw-card" style="padding: 16px; margin-bottom: 12px">
      <strong>{{ g.name }}</strong>
      <span class="sw-hint"> — владелец {{ g.owner_email }}</span>
      <table class="sw-table" style="margin-top: 8px">
        <tbody>
          <tr v-for="m in g.members" :key="m.email">
            <td>{{ m.email }}</td>
            <td>{{ m.role }}</td>
            <td><button class="sw-btn sw-btn--danger" type="button" @click="removeMember(g.id, m.email)">Удалить</button></td>
          </tr>
        </tbody>
      </table>
      <div class="sw-toolbar" style="margin-top: 8px">
        <input v-model="newMemberEmail[g.id]" class="sw-input" placeholder="email@tn.ru" style="max-width: 220px" />
        <select v-model="newMemberRole[g.id]" class="sw-select" style="max-width: 140px">
          <option value="viewer">viewer</option>
          <option value="editor">editor</option>
        </select>
        <button class="sw-btn" type="button" :disabled="busy" @click="addMember(g.id)">Добавить</button>
      </div>
    </div>
  </div>
</template>
