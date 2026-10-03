<script setup lang="ts">
import { ref } from "vue";
import SchedulesView from "./views/SchedulesView.vue";
import KilnsView from "./views/KilnsView.vue";

const tab = ref<"schedules" | "kilns">("kilns");
</script>

<template>
  <header class="topbar">
    <h1>🌲 干燥窑基准与运行监控</h1>
    <nav class="tabs">
      <button :class="{ active: tab === 'kilns' }" @click="tab = 'kilns'">窑位运行（班长）</button>
      <button :class="{ active: tab === 'schedules' }" @click="tab = 'schedules'">基准管理（工艺员）</button>
    </nav>
  </header>
  <main>
    <KilnsView v-if="tab === 'kilns'" />
    <SchedulesView v-else />
  </main>
</template>
