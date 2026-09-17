<template>
  <el-dialog
    :model-value="visible"
    title="指标回看分析"
    width="90%"
    top="5vh"
    class="review-dialog"
    append-to-body
    @update:model-value="(v: boolean) => emit('update:visible', v)"
    @open="handleOpen"
  >
    <!-- 控制栏：测点多选 + 自定义时间段 -->
    <div class="review-controls">
      <div class="control-block control-points">
        <span class="control-label">对比测点：</span>
        <el-checkbox-group v-model="selectedNodeIds" size="small" class="points-group">
          <el-checkbox
            v-for="node in numericNodes"
            :key="node.id"
            :value="node.id"
          >
            <span class="point-name">{{ node.name }}</span>
            <span class="point-unit">{{ node.unit ? '(' + node.unit + ')' : '(数值)' }}</span>
          </el-checkbox>
        </el-checkbox-group>
      </div>

      <div class="control-block control-range">
        <span class="control-label">回看时间段：</span>
        <el-date-picker
          v-model="rangeDates"
          type="datetimerange"
          range-separator="至"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          format="MM-DD HH:mm:ss"
          value-format="x"
          size="small"
          :clearable="false"
          class="range-picker"
        />
        <el-button-group size="small" class="range-shortcuts">
          <el-button v-for="preset in rangePresets" :key="preset.label" @click="applyPreset(preset.minutes)">
            {{ preset.label }}
          </el-button>
        </el-button-group>
      </div>

      <div class="control-block">
        <span class="control-label">纵轴：</span>
        <el-radio-group v-model="chartMode" size="small">
          <el-radio-button value="normalized">归一化对比</el-radio-button>
          <el-radio-button value="raw">原始读数</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <!-- 时间段内没有任何采样：单独说明 -->
    <el-alert
      v-if="selectedNodeIds.length > 0 && totalSampleCount === 0"
      class="empty-alert"
      type="info"
      :closable="false"
      show-icon
    >
      <template #title>
        所选时间段（{{ formatFullTime(rangeStart) }} 至 {{ formatFullTime(rangeEnd) }}）内没有任何采样记录，
        暂无可回看的读数。请调整时间区间后重试；若当前数据源处于断开状态，重新连接后产生的采样才会出现在图中。
      </template>
    </el-alert>

    <!-- 概览视图：多条读数曲线同图对比 -->
    <div class="chart-card review-chart-card">
      <div class="review-chart-header">
        <span class="chart-card-title">概览对比</span>
        <el-tag v-if="store.activeDisconnect" type="danger" size="small" effect="dark">
          数据源断开中：{{ formatTime(store.activeDisconnect.start) }} 起无采样
        </el-tag>
        <el-tag v-else-if="totalSampleCount > 0" type="success" size="small">
          {{ rangeSampleCount }} 条采样落入所选区间
        </el-tag>
      </div>
      <v-chart
        v-if="selectedNodeIds.length > 0 && totalSampleCount > 0"
        :option="chartOption"
        autoresize
        class="review-chart"
      />
      <el-empty v-else :image-size="80" description="暂无曲线（选择测点与有采样的时间段后展示）" />
    </div>

    <!-- 极值统计：与图、明细共用同一份采样 -->
    <div class="stats-card" v-if="selectedNodeIds.length > 0">
      <div class="chart-card-title">测点读数统计</div>
      <el-table :data="statsRows" size="small" class="dark-table" stripe>
        <el-table-column label="测点" min-width="180">
          <template #default="{ row }">
            <span class="legend-dot" :style="{ background: row.color }"></span>
            <span>{{ row.name }}</span>
            <span class="point-unit">{{ row.unit ? '(' + row.unit + ')' : '' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="count" label="采样条数" width="100" align="right" />
        <el-table-column label="最大读数" width="140" align="right">
          <template #default="{ row }">
            <span v-if="row.count === 0" class="text-slate-500">— 无数据</span>
            <span v-else>{{ formatNumber(row.max) }} {{ row.unit }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最小读数" width="140" align="right">
          <template #default="{ row }">
            <span v-if="row.count === 0" class="text-slate-500">— 无数据</span>
            <span v-else>{{ formatNumber(row.min) }} {{ row.unit }}</span>
          </template>
        </el-table-column>
        <el-table-column label="平均读数" width="140" align="right">
          <template #default="{ row }">
            <span v-if="row.count === 0" class="text-slate-500">— 无数据</span>
            <span v-else>{{ formatNumber(row.avg) }} {{ row.unit }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.count === 0" type="info" size="small" effect="dark">无数据</el-tag>
            <el-tag v-else type="success" size="small">正常</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 明细读数：与图/统计读同一份采样，条数一致 -->
    <div class="details-card" v-if="selectedNodeIds.length > 0">
      <div class="chart-card-title">明细读数</div>
      <el-tabs v-model="activeNodeId" class="dark-tabs" @tab-change="detailPage = 1">
        <el-tab-pane
          v-for="row in statsRows"
          :key="row.nodeId"
          :name="row.nodeId"
        >
          <template #label>
            <span class="legend-dot" :style="{ background: row.color }"></span>
            {{ row.name }}（{{ row.count }} 条<span v-if="row.count === 0">，无数据</span>）
          </template>

          <el-table
            :data="pagedSamples(row.nodeId)"
            size="small"
            class="dark-table"
            height="260"
          >
            <el-table-column type="index" label="#" width="60" align="center"
              :index="detailIndex" />
            <el-table-column label="采样时间" min-width="200">
              <template #default="{ row: sample }">{{ formatFullTime(sample.timestamp) }}</template>
            </el-table-column>
            <el-table-column label="读数" width="160" align="right">
              <template #default="{ row: sample }">
                {{ formatNumber(sample.value) }} {{ unitOf(row.nodeId) }}
              </template>
            </el-table-column>
            <el-table-column label="质量码" width="110" align="center">
              <template #default="{ row: sample }">
                <el-tag
                  :type="sample.quality === 'Good' ? 'success' : sample.quality === 'Bad' ? 'danger' : 'warning'"
                  size="small"
                >{{ sample.quality }}</el-tag>
              </template>
            </el-table-column>
          </el-table>

          <div class="pagination-bar" v-if="sampleCountOf(row.nodeId) > 0">
            <el-pagination
              v-model:current-page="detailPage"
              :page-size="PAGE_SIZE"
              :total="sampleCountOf(row.nodeId)"
              layout="prev, pager, next, total"
              small
              background
            />
          </div>
          <el-empty
            v-else
            :image-size="60"
            description="该测点在所选时间段内无数据（数据源断开或未采样，未以零值填充）"
          />
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkAreaComponent
} from 'echarts/components'
import { useOpcuaStore } from '../store/opcua'
import type { OPCUANode, ReviewSample } from '../types'

use([
  CanvasRenderer, LineChart, GridComponent, TooltipComponent,
  LegendComponent, DataZoomComponent, MarkAreaComponent
])

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const store = useOpcuaStore()

const PAGE_SIZE = 15
// 相邻采样间隔超过该阈值即视为采样缺口（正常约 1s/次，断开期间完全不采样），曲线在此断开而不是连线/补零
const GAP_MS = 4500
const SERIES_COLORS = ['#22d3ee', '#a78bfa', '#60a5fa', '#f59e0b', '#34d399', '#f472b6']

const rangePresets = [
  { label: '近1分钟', minutes: 1 },
  { label: '近5分钟', minutes: 5 },
  { label: '近10分钟', minutes: 10 },
  { label: '近30分钟', minutes: 30 },
  { label: '近1小时', minutes: 60 }
]

// 仅数值测点可进入回看对比（布尔状态等不参与曲线/极值统计）
const numericNodes = computed<OPCUANode[]>(() =>
  store.getAllVariableNodes().filter(n => n.dataType === 'Double' || n.dataType === 'Int32')
)

const selectedNodeIds = ref<string[]>([])
const rangeDates = ref<[number, number] | null>(null)
const chartMode = ref<'normalized' | 'raw'>('normalized')
const activeNodeId = ref('')
const detailPage = ref(1)
// 定时刷新刻度：弹窗打开期间让图表随实时采样持续追加
const nowTick = ref(Date.now())
let refreshTimer: number | null = null

watch(() => props.visible, open => {
  if (open) {
    refreshTimer = window.setInterval(() => { nowTick.value = Date.now() }, 2000)
  } else if (refreshTimer !== null) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
})

function handleOpen() {
  // 恢复上次的区间与测点；无历史记录时给默认选择
  store.restoreReviewPrefs()
  const validIds = store.reviewNodeIds.filter(id => numericNodes.value.some(n => n.id === id))
  selectedNodeIds.value = validIds.length > 0
    ? validIds
    : numericNodes.value.slice(0, 2).map(n => n.id)

  const [s, e] = store.reviewRange
  rangeDates.value = (s && e && e > s) ? [s, e] : [Date.now() - 5 * 60 * 1000, Date.now()]
  activeNodeId.value = selectedNodeIds.value[0] ?? ''
  detailPage.value = 1
  nowTick.value = Date.now()
}

// 选择变化即持久化，关闭再打开仍按上次的区间与测点呈现
watch([selectedNodeIds, rangeDates], () => {
  if (rangeDates.value) {
    store.setReviewSelection(selectedNodeIds.value, [rangeDates.value[0], rangeDates.value[1]])
  }
}, { deep: true })

watch(selectedNodeIds, ids => {
  if (ids.length > 0 && !ids.includes(activeNodeId.value)) {
    activeNodeId.value = ids[0]
    detailPage.value = 1
  }
})

function applyPreset(minutes: number) {
  const end = Date.now()
  rangeDates.value = [end - minutes * 60 * 1000, end]
}

const rangeStart = computed(() => rangeDates.value ? Number(rangeDates.value[0]) : 0)
const rangeEnd = computed(() => rangeDates.value ? Number(rangeDates.value[1]) : 0)

interface NodeReviewData {
  node: OPCUANode
  color: string
  samples: ReviewSample[]
}

// 唯一数据源：图、统计表、明细表都从这里取数，保证条数与极值完全一致
const reviewData = computed<Map<string, NodeReviewData>>(() => {
  void nowTick.value // 依赖定时刻度以追加实时采样
  const map = new Map<string, NodeReviewData>()
  numericNodes.value.forEach((node, index) => {
    if (!selectedNodeIds.value.includes(node.id)) return
    map.set(node.id, {
      node,
      color: SERIES_COLORS[index % SERIES_COLORS.length],
      samples: store.getReviewSamples(node.id, rangeStart.value, rangeEnd.value)
    })
  })
  return map
})

const dataList = computed(() => Array.from(reviewData.value.values()))

const totalSampleCount = computed(() =>
  dataList.value.reduce((sum, d) => sum + d.samples.length, 0)
)

// 区间内实际出现过采样的条数（排除掉与区间无交集的缺口区间后，就是各测点条数之和）
const rangeSampleCount = computed(() => totalSampleCount.value)

interface StatsRow {
  nodeId: string
  name: string
  unit: string
  color: string
  count: number
  max: number
  min: number
  avg: number
}

const statsRows = computed<StatsRow[]>(() =>
  dataList.value.map(d => {
    const values = d.samples.map(s => s.value)
    const count = values.length
    const max = count ? Math.max(...values) : NaN
    const min = count ? Math.min(...values) : NaN
    const avg = count ? values.reduce((a, b) => a + b, 0) / count : NaN
    return {
      nodeId: d.node.id,
      name: d.node.name,
      unit: d.node.unit || '',
      color: d.color,
      count,
      max, min, avg
    }
  })
)

function sampleCountOf(nodeId: string) {
  return reviewData.value.get(nodeId)?.samples.length ?? 0
}

function pagedSamples(nodeId: string): ReviewSample[] {
  const samples = reviewData.value.get(nodeId)?.samples ?? []
  // 明细按时间倒序分页：第 1 页为最新 PAGE_SIZE 条
  const end = samples.length - (detailPage.value - 1) * PAGE_SIZE
  const start = Math.max(0, end - PAGE_SIZE)
  return samples.slice(start, end).reverse()
}

function detailIndex(i: number): number {
  return (detailPage.value - 1) * PAGE_SIZE + i + 1
}

function unitOf(nodeId: string) {
  return reviewData.value.get(nodeId)?.node.unit || ''
}

// 与所选区间相交的无数据区间（含进行中的断开），统一裁剪到区间边界
const clippedGaps = computed(() => {
  void nowTick.value
  return store.getNoDataIntervals(rangeStart.value, rangeEnd.value)
    .map(i => ({
      start: Math.max(i.start, rangeStart.value),
      end: Math.min(Number.isFinite(i.end) ? i.end : Date.now(), rangeEnd.value)
    }))
    .filter(i => i.end > i.start)
})

// 构造单条曲线数据：在断开/采样缺口处插入空点，使曲线断开（绝不画成零值）
function buildSeriesPoints(d: NodeReviewData, mode: 'normalized' | 'raw'): Array<[number, number | null] | [number, number, number]> {
  const { samples } = d
  if (samples.length === 0) return []

  let min = samples[0].value
  let max = samples[0].value
  samples.forEach(s => {
    if (s.value < min) min = s.value
    if (s.value > max) max = s.value
  })

  const points: Array<[number, number | null] | [number, number, number]> = []
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    if (mode === 'normalized') {
      const pct = max === min ? 100 : ((s.value - min) / (max - min)) * 100
      points.push([s.timestamp, Number(pct.toFixed(2)), s.value])
    } else {
      points.push([s.timestamp, s.value])
    }
    const next = samples[i + 1]
    if (next && next.timestamp - s.timestamp > GAP_MS) {
      // 同 x 空点：ECharts 在此断开线段，缺口不连线、不补零
      points.push([s.timestamp, null])
    }
  }
  return points
}

const chartOption = computed(() => {
  void nowTick.value
  const mode = chartMode.value
  const selected = dataList.value

  const series: any[] = selected.map((d, index) => ({
    name: d.samples.length === 0 ? `${d.node.name}（无数据）` : d.node.name,
    type: 'line' as const,
    yAxisIndex: mode === 'raw' ? index : 0,
    data: buildSeriesPoints(d, mode),
    smooth: false,
    connectNulls: false,
    symbol: 'none',
    lineStyle: { color: d.color, width: 2 },
    itemStyle: { color: d.color }
  }))

  // 独立的透明序列承载无数据标注区域，即便某条曲线无点，标注依然显示
  series.push({
    name: '__no_data__',
    type: 'line' as const,
    data: [],
    silent: true,
    symbol: 'none',
    markArea: {
      silent: true,
      itemStyle: { color: 'rgba(148, 163, 184, 0.16)', borderColor: '#94a3b8', borderWidth: 1, borderType: 'dashed' },
      label: { show: true, position: 'insideTop', color: '#cbd5e1', fontSize: 11, formatter: '无数据' },
      data: clippedGaps.value.map(g => [
        { xAxis: g.start, name: '无数据' },
        { xAxis: g.end }
      ])
    }
  })

  const yAxis = mode === 'normalized'
    ? [{
        type: 'value' as const,
        min: 0, max: 100,
        name: '归一化 (%)',
        nameTextStyle: { color: '#94a3b8' },
        axisLabel: { color: '#94a3b8', formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(71, 85, 105, 0.35)' } }
      }]
    : selected.map((d, i) => ({
        type: 'value' as const,
        name: d.node.unit || '',
        position: (i % 2 === 0 ? 'left' : 'right') as 'left' | 'right',
        offset: Math.floor(i / 2) * 52,
        nameTextStyle: { color: d.color, fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: d.color } },
        axisLabel: { color: d.color, fontSize: 10 },
        splitLine: { show: i === 0, lineStyle: { color: 'rgba(71, 85, 105, 0.35)' } }
      }))

  return {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0' },
      formatter: (params: any[]) => {
        const valid = params.filter((p: any) => p.seriesName !== '__no_data__' && p.data && p.data[1] !== null)
        if (valid.length === 0) return ''
        const time = formatFullTime(valid[0].data[0])
        const lines = valid.map((p: any) => {
          const d = selected.find(x => p.seriesName === x.node.name || p.seriesName === `${x.node.name}（无数据）`)
          const raw = mode === 'normalized' ? p.data[2] : p.data[1]
          const pct = mode === 'normalized' ? ` <span style="color:#94a3b8">(${p.data[1]}%)</span>` : ''
          return `${p.marker}${p.seriesName}: <b>${formatNumber(raw)}</b> ${d?.node.unit || ''}${pct}`
        })
        return `<div style="font-size:12px"><div style="color:#94a3b8;margin-bottom:4px">${time}</div>${lines.join('<br/>')}</div>`
      }
    },
    legend: {
      top: 0,
      textStyle: { color: '#cbd5e1', fontSize: 11 },
      data: selected.map(d => d.samples.length === 0 ? `${d.node.name}（无数据）` : d.node.name)
    },
    grid: { left: 70, right: 70, top: 42, bottom: 64 },
    xAxis: {
      type: 'time' as const,
      min: rangeStart.value,
      max: rangeEnd.value,
      axisLabel: { color: '#94a3b8', formatter: '{HH}:{mm}:{ss}' },
      axisLine: { lineStyle: { color: '#475569' } },
      splitLine: { show: false }
    },
    yAxis,
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      { type: 'slider', xAxisIndex: 0, height: 18, bottom: 18,
        textStyle: { color: '#94a3b8' }, borderColor: '#334155',
        fillerColor: 'rgba(34, 211, 238, 0.12)' }
    ],
    series
  }
})

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)
}

function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatFullTime(t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
</script>

<style scoped>
.review-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  align-items: flex-start;
  background: rgba(30, 41, 59, 0.5);
  border: 1px solid rgba(71, 85, 105, 0.5);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
}

.control-block {
  display: flex;
  align-items: center;
  gap: 8px;
}

.control-points {
  flex-basis: 100%;
}

.control-label {
  font-size: 13px;
  color: #94a3b8;
  font-weight: 600;
  white-space: nowrap;
}

.points-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.point-name {
  color: #e2e8f0;
}

.point-unit {
  color: #64748b;
  font-size: 11px;
  margin-left: 2px;
}

.range-picker {
  width: 340px;
}

.empty-alert {
  margin-bottom: 12px;
}

.chart-card-title {
  font-size: 14px;
  font-weight: bold;
  color: #22d3ee;
}

.review-chart-card {
  background: rgba(30, 41, 59, 0.6);
  border: 1px solid rgba(71, 85, 105, 0.5);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
}

.review-chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.review-chart {
  height: 380px;
  width: 100%;
}

.stats-card,
.details-card {
  background: rgba(30, 41, 59, 0.6);
  border: 1px solid rgba(71, 85, 105, 0.5);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
}

.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

:deep(.dark-table) {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: rgba(15, 23, 42, 0.8);
  --el-table-border-color: rgba(71, 85, 105, 0.4);
  --el-table-text-color: #cbd5e1;
  --el-table-header-text-color: #94a3b8;
  --el-table-row-hover-bg-color: rgba(6, 182, 212, 0.08);
  background: transparent;
}

:deep(.dark-tabs .el-tabs__item) {
  color: #94a3b8;
}

:deep(.dark-tabs .el-tabs__item.is-active) {
  color: #22d3ee;
}
</style>

<style>
/* el-dialog teleport 到 body，scoped 样式无法命中，用全局类名覆盖 */
.review-dialog.el-dialog {
  background: #0f172a;
  border: 1px solid rgba(71, 85, 105, 0.6);
  border-radius: 10px;
}

.review-dialog .el-dialog__header,
.review-dialog .el-dialog__body {
  color: #e2e8f0;
}

.review-dialog .el-dialog__title {
  color: #22d3ee;
}

.review-dialog .el-dialog__headerbtn .el-dialog__close {
  color: #94a3b8;
}

.review-dialog .el-pagination.is-background .el-pager li:not(.is-active) {
  background-color: #1e293b;
  color: #cbd5e1;
}

.review-dialog .el-tabs__nav-wrap::after {
  background-color: rgba(71, 85, 105, 0.4);
}

.review-dialog .el-tabs--bottom .el-tabs__nav-wrap::after {
  height: 1px;
}

.review-dialog .el-range-editor,
.review-dialog .el-input__wrapper,
.review-dialog .el-pagination .el-pagination__total {
  color: #cbd5e1;
}

.review-dialog .el-pagination__total {
  color: #94a3b8;
}
</style>
