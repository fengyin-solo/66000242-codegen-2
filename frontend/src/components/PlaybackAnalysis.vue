<template>
  <div class="playback-section">
    <!-- 模块标题（可折叠，折叠状态也会记住） -->
    <div class="playback-header" @click="collapsed = !collapsed">
      <h3 class="section-title">指标回看分析</h3>
      <el-icon class="collapse-icon" :class="{ 'is-collapsed': collapsed }">
        <ArrowDown />
      </el-icon>
    </div>

    <div v-show="!collapsed" class="playback-body">
      <!-- 控制条：测点选择 + 自定义时间段，两者关闭重开后都会恢复 -->
      <div class="control-bar">
        <div class="control-item control-points">
          <span class="control-label">对比测点</span>
          <el-select
            v-model="selectedIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            placeholder="挑选若干个测点加入对比"
            class="points-select"
            popper-class="playback-popper"
          >
            <el-option
              v-for="node in numericNodes"
              :key="node.id"
              :label="`${node.name}（${node.description || node.unit || node.dataType}）`"
              :value="node.id"
            />
          </el-select>
        </div>

        <div class="control-item">
          <span class="control-label">时间段</span>
          <el-date-picker
            v-model="range"
            type="datetimerange"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            format="MM-dd HH:mm:ss"
            value-format="x"
            popper-class="playback-popper"
            class="range-picker"
          />
        </div>

        <el-button-group class="quick-ranges">
          <el-button
            v-for="q in quickRanges"
            :key="q.ms"
            :type="isQuickRange(q.ms) ? 'primary' : 'default'"
            size="small"
            @click="applyQuickRange(q.ms)"
          >
            近{{ q.label }}
          </el-button>
        </el-button-group>

        <el-checkbox v-model="normalized" class="normalize-toggle">量程归一化对比</el-checkbox>
      </div>

      <!-- 未选择任何测点 -->
      <el-alert
        v-if="selectedIds.length === 0"
        title="请先挑选至少一个测点"
        description="在上方“对比测点”中选择一个或多个测点，即可在自定义时间段内回看采样读数并对比。"
        type="info"
        :closable="false"
        show-icon
        class="playback-alert"
      />

      <!-- 时间段内没有任何采样（所有测点都没有一条记录）：单独说明，不展示空图与空表 -->
      <el-alert
        v-else-if="totalSampleCount === 0"
        title="所选时间段内没有任何采样数据"
        description="该时间段可能早于采样保留窗口（仅保留最近 1 小时）、晚于当前时间，或处于数据源断开期间。请调整时间段后重试。"
        type="warning"
        :closable="false"
        show-icon
        class="playback-alert"
      />

      <template v-else>
        <!-- 概览视图：多条读数曲线放在同一张图里对比 -->
        <div class="overview-card">
          <div class="overview-head">
            <span class="overview-title">概览对比</span>
            <span class="overview-hint">
              灰色斜纹区间为数据源断开，红色斜纹区间为该测点无数据（断线留空，不计为零值）
            </span>
          </div>
          <v-chart :option="chartOption" autoresize class="overview-chart" />
        </div>

        <!-- 每个测点的最大、最小、平均读数（与图、明细表同一份采样） -->
        <div class="stats-grid">
          <div
            v-for="stat in stats"
            :key="stat.nodeId"
            class="stat-card"
            :style="{ borderTopColor: stat.color }"
          >
            <div class="stat-name">
              <span class="stat-dot" :style="{ background: stat.color }"></span>
              {{ stat.nodeName }}
            </div>
            <div class="stat-unit" v-if="stat.unit">单位：{{ stat.unit }}</div>
            <div class="stat-values">
              <div class="stat-cell">
                <span class="stat-cell-label">最大</span>
                <span class="stat-cell-value text-red-300">{{ stat.maxText }}</span>
              </div>
              <div class="stat-cell">
                <span class="stat-cell-label">最小</span>
                <span class="stat-cell-value text-blue-300">{{ stat.minText }}</span>
              </div>
              <div class="stat-cell">
                <span class="stat-cell-label">平均</span>
                <span class="stat-cell-value text-cyan-300">{{ stat.avgText }}</span>
              </div>
            </div>
            <div class="stat-meta">
              采样 <b>{{ stat.validCount}}</b> 条
              <template v-if="stat.noDataCount > 0">
                · 无数据 <b class="text-orange-300">{{ stat.noDataCount }}</b> 条
              </template>
            </div>
          </div>
        </div>

        <!-- 明细表：逐时刻读数，与图读同一份采样 -->
        <div class="detail-card">
          <div class="detail-head">
            <span class="overview-title">明细读数</span>
            <el-pagination
              v-model:current-page="page"
              :page-size="pageSize"
              :total="rows.length"
              layout="prev, pager, next"
              size="small"
              class="detail-pager"
            />
          </div>
          <el-table :data="pagedRows" size="small" class="detail-table" stripe>
            <el-table-column label="时间" width="180" fixed>
              <template #default="{ row }">
                <span class="font-mono text-slate-300">{{ formatTime(row.timestamp) }}</span>
              </template>
            </el-table-column>
            <el-table-column
              v-for="stat in stats"
              :key="stat.nodeId"
              :label="stat.nodeName + (stat.unit ? `（${stat.unit}）` : '')"
              min-width="150"
              align="center"
            >
              <template #default="{ row }">
                <el-tag v-if="row.cells[stat.nodeId]?.missing" type="info" size="small" effect="plain">
                  无数据
                </el-tag>
                <span v-else-if="row.cells[stat.nodeId]?.value === undefined" class="text-slate-500">—</span>
                <span v-else class="font-mono" :style="{ color: stat.color }">
                  {{ formatCellValue(stat.nodeId, row.cells[stat.nodeId]!.value!) }}
                </span>
              </template>
            </el-table-column>
          </el-table>
          <div class="detail-foot">
            共 {{ rows.length }} 个采样时刻；各测点的采样条数、无数据条数与上方曲线图及极值统计完全一致
            （同一份采样，仅按时间段过滤一次）。
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent,
  DataZoomComponent, MarkAreaComponent
} from 'echarts/components'
import { ArrowDown } from '@element-plus/icons-vue'
import { useOpcuaStore } from '../store/opcua'
import type { OPCUANode, SamplePoint, DisconnectRange } from '../types'

use([
  CanvasRenderer, LineChart,
  GridComponent, TooltipComponent, LegendComponent,
  DataZoomComponent, MarkAreaComponent
])

const store = useOpcuaStore()

/* ---------------- 持久化：关掉再打开仍按上次区间与测点呈现 ---------------- */
const STORAGE_KEY = 'opcua-playback-config'

interface PersistedConfig {
  selectedIds: string[]
  start: number
  end: number
  normalized: boolean
  collapsed: boolean
}

function loadConfig(): Partial<PersistedConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const saved = loadConfig()
// 默认时间段：最近 1 分钟
const defaultStart = Date.now() - 60 * 1000
const selectedIds = ref<string[]>(
  saved.selectedIds?.length
    ? saved.selectedIds
    : ['temp_sensor', 'pressure_transmitter']
)
const range = ref<[number | string, number | string] | null>([
  saved.start ?? defaultStart,
  saved.end ?? Date.now()
])
const normalized = ref<boolean>(saved.normalized ?? false)
const collapsed = ref<boolean>(saved.collapsed ?? false)

watch(
  [selectedIds, range, normalized, collapsed],
  () => {
    if (!range.value) return
    const config: PersistedConfig = {
      selectedIds: selectedIds.value,
      start: Number(range.value[0]),
      end: Number(range.value[1]),
      normalized: normalized.value,
      collapsed: collapsed.value
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  },
  { deep: true }
)

/* ---------------- 快捷时间段 ---------------- */
const quickRanges = [
  { label: '1分钟', ms: 60 * 1000 },
  { label: '5分钟', ms: 5 * 60 * 1000 },
  { label: '15分钟', ms: 15 * 60 * 1000 }
]
function applyQuickRange(ms: number) {
  range.value = [Date.now() - ms, Date.now()]
}
function isQuickRange(ms: number): boolean {
  if (!range.value) return false
  return Math.abs((Number(range.value[1]) - Number(range.value[0])) - ms) < 1000
}

/* ---------------- 节点树“加入回看对比”请求 ---------------- */
watch(
  () => store.playbackPickRequest,
  req => {
    if (!req) return
    if (!numericNodes.value.some(n => n.id === req.nodeId)) return
    if (!selectedIds.value.includes(req.nodeId)) {
      selectedIds.value = [...selectedIds.value, req.nodeId]
    }
    collapsed.value = false
  }
)

/* ---------------- 测点（切换左侧节点树选中不会影响这里的对比选择） ---------------- */
const numericNodes = computed<OPCUANode[]>(() => store.getNumericNodes())
const selectedNodes = computed<OPCUANode[]>(() =>
  selectedIds.value
    .map(id => numericNodes.value.find(n => n.id === id))
    .filter((n): n is OPCUANode => !!n)
)

const COLORS = ['#06b6d4', '#67c23a', '#f59e0b', '#a78bfa', '#60a5fa', '#f472b6']
function colorOf(index: number) {
  return COLORS[index % COLORS.length]
}

// 各测点归一化量程
const NORMALIZE_RANGES: Record<string, [number, number]> = {
  temp_sensor: [0, 50],
  pressure_transmitter: [0, 6],
  flow_meter: [0, 300],
  valve_position: [0, 100],
  motor_speed: [0, 2000]
}

/* ---------------- 统一数据来源：区间内每测点一份采样，图/极值/明细表都读它 ---------------- */
const start = computed(() => Number(range.value?.[0] ?? 0))
const end = computed(() => Number(range.value?.[1] ?? 0))

// nodeId -> 区间内的采样点（直接裁剪同一份 dataHistory）
const samplesByNode = computed<Map<string, SamplePoint[]>>(() => {
  const map = new Map<string, SamplePoint[]>()
  selectedNodes.value.forEach(node => {
    map.set(node.id, store.getSamples(node.id, start.value, end.value))
  })
  return map
})

// 所有测点在区间内是否一条采样都没有（含无数据点也算“有采样时刻”）
const totalSampleCount = computed(() =>
  Array.from(samplesByNode.value.values()).reduce((sum, list) => sum + list.length, 0)
)

interface NodeStat {
  nodeId: string
  nodeName: string
  unit?: string
  color: string
  total: number
  validCount: number
  noDataCount: number
  max: number | null
  min: number | null
  avg: number | null
  maxText: string
  minText: string
  avgText: string
  precision: number
}

function precisionOf(node: OPCUANode): number {
  return node.dataType === 'Int32' ? 0 : 2
}
function formatByPrecision(v: number, precision: number): string {
  return v.toFixed(precision)
}

const stats = computed<NodeStat[]>(() =>
  selectedNodes.value.map((node, index) => {
    const points = samplesByNode.value.get(node.id) || []
    const valid = points.filter(p => p.value !== null).map(p => p.value as number)
    const precision = precisionOf(node)
    const max = valid.length ? Math.max(...valid) : null
    const min = valid.length ? Math.min(...valid) : null
    const avg = valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : null
    return {
      nodeId: node.id,
      nodeName: node.name,
      unit: node.unit,
      color: colorOf(index),
      total: points.length,
      validCount: valid.length,
      noDataCount: points.length - valid.length,
      max, min, avg,
      maxText: max === null ? '无数据' : formatByPrecision(max, precision),
      minText: min === null ? '无数据' : formatByPrecision(min, precision),
      avgText: avg === null ? '无数据' : formatByPrecision(avg, precision),
      precision
    }
  })
)

/* ---------------- 明细表行：按时间点对齐所有被选测点 ---------------- */
interface TableRow {
  timestamp: number
  cells: Record<string, { value: number } | { missing: true }>
}

const rows = computed<TableRow[]>(() => {
  const timestampSet = new Set<number>()
  samplesByNode.value.forEach(list => list.forEach(p => timestampSet.add(p.timestamp)))
  const timestamps = Array.from(timestampSet).sort((a, b) => b - a) // 明细按时间倒序

  return timestamps.map(timestamp => {
    const cells: TableRow['cells'] = {}
    selectedNodes.value.forEach(node => {
      const point = (samplesByNode.value.get(node.id) || []).find(p => p.timestamp === timestamp)
      if (!point) {
        // 该时刻此测点没有采样记录
        cells[node.id] = { missing: true }
      } else if (point.value === null) {
        // 数据源断开/坏点：标注无数据
        cells[node.id] = { missing: true }
      } else {
        cells[node.id] = { value: point.value }
      }
    })
    return { timestamp, cells }
  })
})

const pageSize = 20
const page = ref(1)
// 条件变化时回到第一页
watch([rows, selectedIds, range], () => { page.value = 1 })
const pagedRows = computed(() => rows.value.slice((page.value - 1) * pageSize, page.value * pageSize))

function formatCellValue(nodeId: string, v: number): string {
  // 明细表与极值统计使用相同展示精度（依据测点数据类型）
  const stat = stats.value.find(s => s.nodeId === nodeId)
  const precision = stat?.precision ?? 2
  return formatByPrecision(v, precision)
}
function formatTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
}

/* ---------------- 概览图：同一张图内多条曲线，无数据留空并标注 ---------------- */
// 找出连续无数据区间（null 段），用于 markArea 标注
function findGapRuns(points: SamplePoint[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let runStart: number | null = null
  let lastTs: number | null = null
  points.forEach(p => {
    if (p.value === null) {
      if (runStart === null) runStart = p.timestamp
      lastTs = p.timestamp
    } else {
      if (runStart !== null && lastTs !== null) runs.push([runStart, lastTs])
      runStart = null
    }
  })
  if (runStart !== null && lastTs !== null) runs.push([runStart, lastTs])
  return runs
}

// 区间 [a,b] 是否完全落在某段数据源断开区间内（避免重复标注）
function coveredByDisconnect(a: number, b: number): boolean {
  return store.disconnectRanges.some((r: DisconnectRange) => {
    const rEnd = r.end ?? Date.now()
    return r.start <= a && rEnd >= b
  })
}

// 与回看窗口相交的数据源断开区间
const viewDisconnectRuns = computed<Array<[number, number]>>(() => {
  const now = Date.now()
  const runs: Array<[number, number]> = []
  store.disconnectRanges.forEach((r: DisconnectRange) => {
    const rEnd = r.end ?? now
    const s = Math.max(r.start, start.value)
    const e = Math.min(rEnd, end.value)
    if (s <= e) runs.push([s, e])
  })
  return runs
})

function gapAreaItem(gStart: number, gEnd: number, global: boolean, showLabel: boolean) {
  return [
    {
      xAxis: gStart - 500,
      itemStyle: {
        color: global ? 'rgba(148, 163, 184, 0.18)' : 'rgba(239, 68, 68, 0.12)',
        borderColor: global ? 'rgba(148, 163, 184, 0.6)' : 'rgba(239, 68, 68, 0.5)',
        borderWidth: 1,
        borderType: 'dashed'
      },
      label: {
        show: showLabel,
        formatter: global ? '数据源断开' : '无数据',
        color: global ? '#94a3b8' : '#fca5a5',
        fontSize: 11,
        position: 'insideTop'
      }
    },
    { xAxis: gEnd + 500 }
  ]
}

function normalizeValue(nodeId: string, v: number): number {
  const rangeSpec = NORMALIZE_RANGES[nodeId] || [0, 100]
  const span = rangeSpec[1] - rangeSpec[0] || 1
  return (v - rangeSpec[0]) / span * 100
}

const chartOption = computed(() => {
  const selected = selectedNodes.value

  const series = selected.map((node, index) => {
    const points = samplesByNode.value.get(node.id) || []
    const data = points.map(p => [
      p.timestamp,
      p.value === null ? null : (normalized.value ? normalizeValue(node.id, p.value) : p.value)
    ])

    // 无数据区间标注：
    // 1) 数据源断开区间（即使断开后没有产生任何采样点，也要在图上标出来）；
    // 2) 测点自身的坏数据窗口，完全被断开区间覆盖的不再重复标注。
    const gapRuns = findGapRuns(points)
    const markAreas: any[] = []
    viewDisconnectRuns.value.forEach(run => {
      markAreas.push(gapAreaItem(run[0], run[1], true, true))
    })
    gapRuns.forEach(([gStart, gEnd]) => {
      if (!coveredByDisconnect(gStart, gEnd)) {
        markAreas.push(gapAreaItem(gStart, gEnd, false, true))
      }
    })

    return {
      name: node.name,
      type: 'line' as const,
      data,
      // connectNulls 必须为 false：无数据处断线，绝不连到零
      connectNulls: false,
      showSymbol: false,
      smooth: false,
      lineStyle: { width: 2, color: colorOf(index) },
      itemStyle: { color: colorOf(index) },
      emphasis: { focus: 'series' as const },
      markArea: { silent: true, data: markAreas }
    }
  })

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0' },
      axisPointer: { type: 'line' as const },
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return ''
        const ts = params[0].value[0]
        const timeText = formatTime(ts)
        const lines = params
          .filter((p: any) => p.value?.[1] !== null && p.value?.[1] !== undefined)
          .map((p: any) => {
            const stat = stats.value.find(s => s.nodeName === p.seriesName)
            const node = selected.find(n => n.name === p.seriesName)
            let display: string
            if (node && normalized.value) {
              // 归一化模式下 tooltip 反查原始读数
              const raw = (samplesByNode.value.get(node.id) || [])
                .find(pt => pt.timestamp === ts)?.value
              display = raw === null || raw === undefined
                ? '无数据'
                : `${formatByPrecision(raw, stat?.precision ?? 2)}${node.unit ? ' ' + node.unit : ''}`
            } else {
              display = `${formatByPrecision(p.value[1], stat?.precision ?? 2)}${node?.unit ? ' ' + node.unit : ''}`
            }
            return `${p.marker}${p.seriesName}: <b>${display}</b>`
          })
        return `${timeText}<br/>${lines.join('<br/>') || '该时刻无有效读数'}`
      }
    },
    legend: {
      top: 4,
      textStyle: { color: '#cbd5e1' },
      inactiveColor: '#475569'
    },
    grid: { left: 64, right: 24, top: 44, bottom: 64 },
    xAxis: {
      type: 'time' as const,
      axisLabel: { color: '#94a3b8', formatter: '{HH}:{mm}:{ss}' },
      axisLine: { lineStyle: { color: '#334155' } }
    },
    yAxis: {
      type: 'value' as const,
      name: normalized.value ? '量程占比 (%)' : '',
      axisLabel: {
        color: '#94a3b8',
        formatter: normalized.value ? '{value}%' : '{value}'
      },
      splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.5)' } }
    },
    dataZoom: [
      { type: 'inside' as const, start: 0, end: 100 },
      {
        type: 'slider' as const,
        start: 0, end: 100,
        height: 18, bottom: 14,
        backgroundColor: 'rgba(30, 41, 59, 0.6)',
        fillerColor: 'rgba(6, 182, 212, 0.18)',
        borderColor: '#334155',
        textStyle: { color: '#94a3b8' }
      }
    ],
    series
  }
})
</script>

<style scoped>
.playback-section {
  margin-top: 20px;
  background: rgba(30, 41, 59, 0.4);
  border: 1px solid rgba(71, 85, 105, 0.5);
  border-radius: 8px;
  padding: 12px;
}

.playback-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}

.playback-header .section-title {
  margin-bottom: 0;
}

.collapse-icon {
  color: #94a3b8;
  transition: transform 0.2s;
}
.collapse-icon.is-collapsed {
  transform: rotate(-90deg);
}

.playback-body {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.control-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.control-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.control-points {
  min-width: 320px;
  flex: 1 1 320px;
}

.control-label {
  font-size: 13px;
  color: #94a3b8;
  white-space: nowrap;
}

.points-select {
  flex: 1;
}

.range-picker {
  width: 360px;
}

.normalize-toggle {
  color: #cbd5e1;
  margin-left: auto;
}

.playback-alert {
  margin: 0;
}

.overview-card,
.detail-card {
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid rgba(71, 85, 105, 0.5);
  border-radius: 8px;
  padding: 12px;
}

.overview-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}

.overview-title {
  font-size: 14px;
  font-weight: bold;
  color: #22d3ee;
}

.overview-hint {
  font-size: 12px;
  color: #64748b;
}

.overview-chart {
  height: 360px;
  width: 100%;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.stat-card {
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid rgba(71, 85, 105, 0.5);
  border-top: 3px solid #06b6d4;
  border-radius: 8px;
  padding: 12px;
}

.stat-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.stat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.stat-unit {
  font-size: 11px;
  color: #64748b;
  margin-top: 2px;
}

.stat-values {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.stat-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-cell-label {
  font-size: 11px;
  color: #64748b;
}

.stat-cell-value {
  font-size: 16px;
  font-weight: bold;
  font-family: 'Courier New', monospace;
}

.stat-meta {
  margin-top: 8px;
  font-size: 12px;
  color: #94a3b8;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.detail-foot {
  margin-top: 8px;
  font-size: 12px;
  color: #64748b;
}

:deep(.detail-table) {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: #1e293b;
  --el-table-header-text-color: #cbd5e1;
  --el-table-text-color: #e2e8f0;
  --el-table-border-color: rgba(71, 85, 105, 0.5);
  --el-table-row-hover-bg-color: rgba(6, 182, 212, 0.08);
  background: transparent;
}

:deep(.detail-pager) {
  --el-pagination-bg-color: transparent;
  --el-pagination-text-color: #cbd5e1;
  --el-pagination-button-color: #cbd5e1;
  --el-pagination-button-bg-color: rgba(30, 41, 59, 0.8);
}

:deep(.playback-popper) {
  background: #1e293b;
  border-color: #334155;
}

@media (max-width: 1200px) {
  .range-picker { width: 100%; }
  .normalize-toggle { margin-left: 0; }
}
</style>
