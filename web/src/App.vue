<script setup lang="ts">
import { ref } from 'vue';
import KilnBoard from './views/KilnBoard.vue';
import ScheduleEditor from './views/ScheduleEditor.vue';

const tab = ref<'kilns' | 'schedules'>('kilns');
</script>

<template>
  <header class="topbar">
    <h1>木材干燥窑 · 基准与运行系统</h1>
    <nav class="tabs">
      <button :class="{ active: tab === 'kilns' }" @click="tab = 'kilns'">
        窑位运行
      </button>
      <button :class="{ active: tab === 'schedules' }" @click="tab = 'schedules'">
        干燥基准
      </button>
    </nav>
  </header>
  <main>
    <KilnBoard v-if="tab === 'kilns'" />
    <ScheduleEditor v-else />
  </main>
</template>
