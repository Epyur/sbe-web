<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { sessionState, clearSession } from './store/session';

const route = useRoute();
const router = useRouter();

const showChrome = computed(() => route.name !== 'login' && route.name !== 'verify');
const email = computed(() => sessionState.session?.email ?? '');

function logout(): void {
  clearSession();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="sw-shell">
    <header v-if="showChrome" class="sw-topbar">
      <RouterLink to="/" class="sw-topbar__brand">LogicTEAM.WWW</RouterLink>
      <nav class="sw-topbar__nav">
        <RouterLink to="/photobank" class="sw-topbar__link">Фотобанк</RouterLink>
        <RouterLink to="/requests" class="sw-topbar__link">Заявки на испытания</RouterLink>
        <RouterLink to="/agent" class="sw-topbar__link">LogicTEAM.007</RouterLink>
      </nav>
      <div class="sw-topbar__user">
        <RouterLink to="/settings" class="sw-topbar__gear" title="Настройки">⚙️</RouterLink>
        <span class="sw-topbar__email">{{ email }}</span>
        <button class="sw-btn sw-btn--ghost" type="button" @click="logout">Выйти</button>
      </div>
    </header>
    <main class="sw-main">
      <RouterView />
    </main>
  </div>
</template>
