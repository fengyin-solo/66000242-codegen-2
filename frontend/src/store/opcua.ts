import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { OPCUANode, DataValue, AlarmEvent, SubscriptionConfig, ReviewSample, NoDataInterval } from '../types'

// 回看分析最多保留的采样点数（约 60 分钟秒级采样）
const REVIEW_MAX_SAMPLES = 3600
// 回看选择持久化键
const REVIEW_PREFS_KEY = 'opcua-review-prefs'

interface ReviewPrefs {
  nodeIds: string[]
  rangeStart: number
  rangeEnd: number
}

function loadReviewPrefs(): ReviewPrefs | null {
  try {
    const raw = localStorage.getItem(REVIEW_PREFS_KEY)
    return raw ? JSON.parse(raw) as ReviewPrefs : null
  } catch {
    return null
  }
}

export const useOpcuaStore = defineStore('opcua', () => {
  // 状态
  const nodeTree = ref<OPCUANode[]>([])
  const selectedNode = ref<OPCUANode | null>(null)
  const subscriptions = ref<Map<string, SubscriptionConfig>>(new Map())
  const alarms = ref<AlarmEvent[]>([])
  const realTimeData = ref<Map<string, DataValue>>(new Map())
  const isConnected = ref(false)
  const dataHistory = ref<Map<string, Array<{ timestamp: number; value: number }>>>(new Map())

  // ---- 指标回看分析 ----
  // 与 dataHistory 相互独立：现有固定曲线继续只读 dataHistory，不受回看影响
  const reviewHistory = ref<Map<string, ReviewSample[]>>(new Map())
  // 数据源断开区间（历史的 + 当前持续中的）
  const noDataIntervals = ref<NoDataInterval[]>([])
  const disconnectSince = ref<number | null>(null)
  // 用户选择的测点与时间区间，关闭后重开仍保留
  const reviewNodeIds = ref<string[]>([])
  const reviewRange = ref<[number, number]>([Date.now() - 5 * 60 * 1000, Date.now()])
  let reviewPrefsLoaded = false

  function restoreReviewPrefs() {
    if (reviewPrefsLoaded) return
    reviewPrefsLoaded = true
    const prefs = loadReviewPrefs()
    if (prefs) {
      reviewNodeIds.value = prefs.nodeIds
      reviewRange.value = [prefs.rangeStart, prefs.rangeEnd]
    }
  }

  function persistReviewPrefs() {
    const prefs: ReviewPrefs = {
      nodeIds: reviewNodeIds.value,
      rangeStart: reviewRange.value[0],
      rangeEnd: reviewRange.value[1]
    }
    try {
      localStorage.setItem(REVIEW_PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // localStorage 不可用时静默降级为仅内存保留
    }
  }

  // 初始化模拟节点树
  function initNodeTree() {
    nodeTree.value = [
      {
        id: 'server',
        name: 'Server',
        nodeId: 'ns=0;i=2253',
        type: 'Object',
        description: 'OPC-UA 服务器根节点',
        children: [
          {
            id: 'objects',
            name: 'Objects',
            nodeId: 'ns=0;i=85',
            type: 'Object',
            description: '对象文件夹',
            children: [
              {
                id: 'plc_area1',
                name: 'PLC_Area1',
                nodeId: 'ns=2;i=1001',
                type: 'Object',
                description: '1号生产区域 PLC',
                children: [
                  {
                    id: 'temp_sensor',
                    name: 'Temperature_Sensor',
                    nodeId: 'ns=2;i=1002',
                    type: 'Variable',
                    dataType: 'Double',
                    value: 25.6,
                    unit: '°C',
                    quality: 'Good',
                    description: '温度传感器'
                  },
                  {
                    id: 'pressure_transmitter',
                    name: 'Pressure_Transmitter',
                    nodeId: 'ns=2;i=1003',
                    type: 'Variable',
                    dataType: 'Double',
                    value: 3.45,
                    unit: 'MPa',
                    quality: 'Good',
                    description: '压力变送器'
                  },
                  {
                    id: 'pump_status',
                    name: 'Pump_Status',
                    nodeId: 'ns=2;i=1004',
                    type: 'Variable',
                    dataType: 'Boolean',
                    value: true,
                    quality: 'Good',
                    description: '泵运行状态'
                  }
                ]
              },
              {
                id: 'plc_area2',
                name: 'PLC_Area2',
                nodeId: 'ns=2;i=2001',
                type: 'Object',
                description: '2号生产区域 PLC',
                children: [
                  {
                    id: 'flow_meter',
                    name: 'Flow_Meter',
                    nodeId: 'ns=2;i=2002',
                    type: 'Variable',
                    dataType: 'Double',
                    value: 156.7,
                    unit: 'L/min',
                    quality: 'Good',
                    description: '流量计'
                  },
                  {
                    id: 'valve_position',
                    name: 'Valve_Position',
                    nodeId: 'ns=2;i=2003',
                    type: 'Variable',
                    dataType: 'Double',
                    value: 75,
                    unit: '%',
                    quality: 'Good',
                    description: '阀门开度'
                  },
                  {
                    id: 'motor_speed',
                    name: 'Motor_Speed',
                    nodeId: 'ns=2;i=2004',
                    type: 'Variable',
                    dataType: 'Int32',
                    value: 1480,
                    unit: 'RPM',
                    quality: 'Good',
                    description: '电机转速'
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }

  // 模拟实时数据更新
  function simulateDataUpdate() {
    if (!isConnected.value) return
    // 首次采样前回填历史（此时 Date.now() 与首个实时点只相差 1s，不会产生伪缺口）
    backfillReviewHistory()
    const nodes = getAllVariableNodes()
    nodes.forEach(node => {
      const currentValue = realTimeData.value.get(node.id)?.value ?? node.value
      
      let newValue: number | boolean | string
      if (node.dataType === 'Double') {
        const numVal = typeof currentValue === 'number' ? currentValue : parseFloat(String(currentValue))
        const variation = (Math.random() - 0.5) * 2
        newValue = Math.round((numVal + variation) * 100) / 100
      } else if (node.dataType === 'Int32') {
        const numVal = typeof currentValue === 'number' ? currentValue : parseInt(String(currentValue))
        const variation = Math.floor((Math.random() - 0.5) * 10)
        newValue = numVal + variation
      } else if (node.dataType === 'Boolean') {
        newValue = Math.random() > 0.95 ? !currentValue : currentValue
      } else {
        newValue = currentValue
      }

      const dataValue: DataValue = {
        nodeId: node.nodeId,
        value: newValue,
        quality: Math.random() > 0.98 ? 'Uncertain' : 'Good',
        timestamp: Date.now(),
        sourceTimestamp: Date.now(),
        serverTimestamp: Date.now()
      }

      realTimeData.value.set(node.id, dataValue)
      node.value = newValue
      node.quality = dataValue.quality

      // 记录历史数据
      const history = dataHistory.value.get(node.id) || []
      history.push({ timestamp: Date.now(), value: typeof newValue === 'number' ? newValue : 0 })
      if (history.length > 100) history.shift()
      dataHistory.value.set(node.id, history)

      // 记录回看采样：仅数值测点且质量码非 Bad（Bad 表示读取失败，不是有效读数，不能当零值）
      if (typeof newValue === 'number' && dataValue.quality !== 'Bad') {
        const reviewSamples = reviewHistory.value.get(node.id) || []
        reviewSamples.push({ timestamp: Date.now(), value: newValue, quality: dataValue.quality })
        if (reviewSamples.length > REVIEW_MAX_SAMPLES) reviewSamples.shift()
        reviewHistory.value.set(node.id, reviewSamples)
      }

      // 检查报警条件
      checkAlarms(node, newValue)
    })
  }

  // 检查报警
  function checkAlarms(node: OPCUANode, value: number | boolean | string) {
    if (node.id === 'temp_sensor' && typeof value === 'number' && value > 28) {
      addAlarm({
        nodeId: node.nodeId,
        nodeName: node.name,
        severity: 'High',
        message: `温度过高: ${value}°C (阈值: 28°C)`,
        value,
        threshold: 28
      })
    }
    if (node.id === 'pressure_transmitter' && typeof value === 'number' && value > 4.0) {
      addAlarm({
        nodeId: node.nodeId,
        nodeName: node.name,
        severity: 'Critical',
        message: `压力超限: ${value} MPa (阈值: 4.0 MPa)`,
        value,
        threshold: 4.0
      })
    }
    if (node.id === 'motor_speed' && typeof value === 'number' && value > 1550) {
      addAlarm({
        nodeId: node.nodeId,
        nodeName: node.name,
        severity: 'Medium',
        message: `电机转速偏高: ${value} RPM (阈值: 1550 RPM)`,
        value,
        threshold: 1550
      })
    }
  }

  // 添加报警
  function addAlarm(alarm: Omit<AlarmEvent, 'id' | 'timestamp' | 'acknowledged'>) {
    const newAlarm: AlarmEvent = {
      ...alarm,
      id: `alarm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      acknowledged: false
    }
    alarms.value.unshift(newAlarm)
    if (alarms.value.length > 50) alarms.value.pop()
  }

  // 获取所有变量节点
  function getAllVariableNodes(): OPCUANode[] {
    const variables: OPCUANode[] = []
    function traverse(nodes: OPCUANode[]) {
      nodes.forEach(node => {
        if (node.type === 'Variable') {
          variables.push(node)
        }
        if (node.children) {
          traverse(node.children)
        }
      })
    }
    traverse(nodeTree.value)
    return variables
  }

  // 选择节点
  function selectNode(node: OPCUANode) {
    selectedNode.value = node
  }

  // 添加订阅
  function addSubscription(nodeId: string, config: Partial<SubscriptionConfig> = {}) {
    const subscription: SubscriptionConfig = {
      nodeId,
      publishingInterval: config.publishingInterval || 1000,
      samplingInterval: config.samplingInterval || 500,
      queueSize: config.queueSize || 10,
      discardOldest: config.discardOldest ?? true,
      enabled: true
    }
    subscriptions.value.set(nodeId, subscription)
  }

  // 移除订阅
  function removeSubscription(nodeId: string) {
    subscriptions.value.delete(nodeId)
  }

  // 确认报警
  function acknowledgeAlarm(alarmId: string) {
    const alarm = alarms.value.find(a => a.id === alarmId)
    if (alarm) {
      alarm.acknowledged = true
    }
  }

  // 清空报警
  function clearAlarms() {
    alarms.value = []
  }

  // 连接模拟
  function connect() {
    // 从断开中恢复：闭合当前的无数据区间
    if (disconnectSince.value !== null) {
      noDataIntervals.value.push({ start: disconnectSince.value, end: Date.now() })
      disconnectSince.value = null
    }
    isConnected.value = true
    initNodeTree()
  }

  // 首次收到实时采样前回填一段历史采样，使回看模块在刚进入页面时也有数据可看
  // 仅回填回看缓冲，实时曲线使用的 dataHistory 不受影响
  function backfillReviewHistory() {
    if (reviewHistory.value.size > 0) return
    const now = Date.now()
    const spanMs = 30 * 60 * 1000
    const stepMs = 5000
    const numericNodes = getAllVariableNodes().filter(
      n => (n.dataType === 'Double' || n.dataType === 'Int32') && typeof n.value === 'number'
    )
    numericNodes.forEach(node => {
      const base = node.value as number
      const samples: ReviewSample[] = []
      for (let t = now - spanMs; t <= now; t += stepMs) {
        const noise = (Math.random() - 0.5) * (node.dataType === 'Int32' ? 24 : base * 0.04)
        const v = node.dataType === 'Int32'
          ? Math.round(base + noise)
          : Math.round((base + noise) * 100) / 100
        samples.push({
          timestamp: t,
          value: v,
          quality: Math.random() > 0.97 ? 'Uncertain' : 'Good'
        })
      }
      reviewHistory.value.set(node.id, samples)
    })
  }

  // 断开连接
  function disconnect() {
    if (isConnected.value) {
      disconnectSince.value = Date.now()
    }
    isConnected.value = false
  }

  // ---- 回看分析数据查询 ----
  // 返回当前仍在持续的断开区间（未闭合）
  const activeDisconnect = computed<NoDataInterval | null>(() =>
    disconnectSince.value !== null ? { start: disconnectSince.value, end: Infinity } : null
  )

  // 与 [start, end] 有交集的无数据区间（含进行中的断开）
  function getNoDataIntervals(start: number, end: number): NoDataInterval[] {
    const intervals = noDataIntervals.value.filter(i => i.end >= start && i.start <= end)
    const active = activeDisconnect.value
    if (active && active.end >= start && active.start <= end) intervals.push(active)
    return intervals
  }

  // 取测点在 [start, end] 内的采样（复制数组，避免视图侧误改缓冲）
  function getReviewSamples(nodeId: string, start: number, end: number): ReviewSample[] {
    const samples = reviewHistory.value.get(nodeId) || []
    return samples.filter(s => s.timestamp >= start && s.timestamp <= end)
  }

  // 保存回看选择：切换测点、关闭重开均不丢失
  function setReviewSelection(nodeIds: string[], range: [number, number]) {
    reviewNodeIds.value = [...nodeIds]
    reviewRange.value = [range[0], range[1]]
    persistReviewPrefs()
  }

  // 计算属性
  const activeAlarmsCount = computed(() => alarms.value.filter(a => !a.acknowledged).length)
  const criticalAlarmsCount = computed(() => alarms.value.filter(a => a.severity === 'Critical' && !a.acknowledged).length)

  return {
    // 状态
    nodeTree,
    selectedNode,
    subscriptions,
    alarms,
    realTimeData,
    isConnected,
    dataHistory,
    // 回看分析
    reviewHistory,
    noDataIntervals,
    reviewNodeIds,
    reviewRange,
    activeDisconnect,
    // 方法
    initNodeTree,
    simulateDataUpdate,
    selectNode,
    addSubscription,
    removeSubscription,
    acknowledgeAlarm,
    clearAlarms,
    connect,
    disconnect,
    getAllVariableNodes,
    restoreReviewPrefs,
    getReviewSamples,
    getNoDataIntervals,
    setReviewSelection,
    // 计算属性
    activeAlarmsCount,
    criticalAlarmsCount
  }
})
