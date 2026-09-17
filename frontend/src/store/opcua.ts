import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { OPCUANode, DataValue, AlarmEvent, SubscriptionConfig, SamplePoint, DisconnectRange } from '../types'

// 回看分析保留的采样时长：最近 1 小时（采样间隔 1s）
const HISTORY_LIMIT = 3600
const HISTORY_RETENTION_MS = HISTORY_LIMIT * 1000

export const useOpcuaStore = defineStore('opcua', () => {
  // 状态
  const nodeTree = ref<OPCUANode[]>([])
  const selectedNode = ref<OPCUANode | null>(null)
  const subscriptions = ref<Map<string, SubscriptionConfig>>(new Map())
  const alarms = ref<AlarmEvent[]>([])
  const realTimeData = ref<Map<string, DataValue>>(new Map())
  const isConnected = ref(false)
  // 每个测点一份采样，value 可能为 null（该时刻无数据），回看分析与固定曲线都读它
  const dataHistory = ref<Map<string, SamplePoint[]>>(new Map())
  // 数据源断开区间，回看时用于在图上标注“无数据”
  const disconnectRanges = ref<DisconnectRange[]>([])
  // 节点树向回看模块发起“加入对比”的请求信号（不直接持有回看选择，避免与模块持久化耦合）
  const playbackPickRequest = ref<{ nonce: number; nodeId: string } | null>(null)

  // 每个测点的“坏数据窗口”剩余采样数（模拟数据源短期中断，不随响应式暴露）
  const badWindowRemaining = new Map<string, number>()

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
    const now = Date.now()
    const nodes = getAllVariableNodes()
    nodes.forEach(node => {
      const currentValue = realTimeData.value.get(node.id)?.value ?? node.value
      const numeric = typeof currentValue === 'number' || node.dataType !== 'Boolean'

      // 数据源中断窗口内不产生有效采样
      let remaining = badWindowRemaining.get(node.id) ?? 0
      if (remaining <= 0 && numeric && Math.random() < 0.008) {
        // 随机开启一次 3~8 秒的短期中断
        remaining = 3 + Math.floor(Math.random() * 6)
      }
      const inBadWindow = remaining > 0
      if (remaining > 0) {
        badWindowRemaining.set(node.id, remaining - 1)
      }

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

      const quality: DataValue['quality'] = inBadWindow ? 'Bad' : Math.random() > 0.98 ? 'Uncertain' : 'Good'

      const dataValue: DataValue = {
        nodeId: node.nodeId,
        // 中断期间无有效读数，保留最近一次数值仅用于实时卡片，质量码明确为 Bad
        value: inBadWindow ? currentValue : newValue,
        quality,
        timestamp: now,
        sourceTimestamp: now,
        serverTimestamp: now
      }

      realTimeData.value.set(node.id, dataValue)
      node.quality = quality
      if (!inBadWindow) {
        node.value = newValue
      }

      // 记录采样：中断/坏质量时刻写入 null（无数据），不能记成 0；仅数值测点参与曲线
      if (node.dataType !== 'Boolean') {
        const history = dataHistory.value.get(node.id) || []
        history.push({
          timestamp: now,
          value: inBadWindow ? null : (newValue as number),
          quality
        })
        // 按时间与条数双重裁剪，保留最近一小时采样
        while (history.length > HISTORY_LIMIT ||
          (history.length > 0 && now - history[0].timestamp > HISTORY_RETENTION_MS)) {
          history.shift()
        }
        dataHistory.value.set(node.id, history)
      }

      // 检查报警条件（无数据时不参与越限判断）
      if (!inBadWindow) {
        checkAlarms(node, newValue)
      }
    })
  }

  // 回看分析：取指定测点在 [start, end] 内的采样（裁剪自同一份 dataHistory）
  function getSamples(nodeId: string, start: number, end: number): SamplePoint[] {
    const history = dataHistory.value.get(nodeId) || []
    return history.filter(p => p.timestamp >= start && p.timestamp <= end)
  }

  // 从节点树把测点加入回看对比
  function requestPlaybackPick(nodeId: string) {
    playbackPickRequest.value = { nonce: Date.now() + Math.random(), nodeId }
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

  // 回看分析可选测点：仅数值型测点参与曲线对比
  function getNumericNodes(): OPCUANode[] {
    return getAllVariableNodes().filter(n => n.dataType !== 'Boolean')
  }

  // 预置最近 5 分钟采样，使首次进入/重开时回看区间内就有数据可看；
  // 其中包含一段所有测点同时无数据的“数据源断开”区间与各测点自身的坏点
  function seedHistory() {
    if (dataHistory.value.size > 0) return
    const now = Date.now()
    const nodes = getNumericNodes()

    // 确定性的伪随机，保证同一时刻同一测点取到相同种子值
    function seeded(nodeIndex: number, t: number, salt: number) {
      const x = Math.sin(nodeIndex * 127.1 + t * 0.031 + salt * 13.7) * 43758.5453
      return x - Math.floor(x)
    }
    function baseValue(node: OPCUANode): number {
      return typeof node.value === 'number' ? node.value : 0
    }
    function seedValue(node: OPCUANode, nodeIndex: number, t: number): number {
      const base = baseValue(node)
      const span = Math.max(Math.abs(base) * 0.08, 1)
      const wave = Math.sin(t / 30 + nodeIndex) * span * 0.8
      const noise = (seeded(nodeIndex, t, 1) - 0.5) * span
      const v = base + wave + noise
      return node.dataType === 'Int32' ? Math.round(v) : Math.round(v * 100) / 100
    }

    const gapStart = now - 1000 * 90
    const gapEnd = now - 1000 * 78

    nodes.forEach((node, nodeIndex) => {
      const points: SamplePoint[] = []
      // 各测点自身的一小段坏数据窗口（与全局断开区间错开）
      const ownBadStart = now - 1000 * (200 + nodeIndex * 15)
      const ownBadEnd = ownBadStart + 1000 * (4 + (nodeIndex % 3))

      for (let t = now - 1000 * 300; t <= now; t += 1000) {
        const inGlobalGap = t >= gapStart && t <= gapEnd
        const inOwnBad = t >= ownBadStart && t <= ownBadEnd
        if (inGlobalGap || inOwnBad) {
          points.push({ timestamp: t, value: null, quality: 'Bad' })
        } else {
          points.push({ timestamp: t, value: seedValue(node, nodeIndex, Math.floor(t / 1000)), quality: 'Good' })
        }
      }
      dataHistory.value.set(node.id, points)
    })

    disconnectRanges.value = [{ start: gapStart, end: gapEnd }]
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
    isConnected.value = true
    initNodeTree()
    seedHistory()
    // 闭合可能存在的断开区间（由断开操作开启）
    const now = Date.now()
    disconnectRanges.value.forEach(r => {
      if (r.end === null) r.end = now
    })
    pruneDisconnectRanges()
  }

  // 断开连接
  function disconnect() {
    if (isConnected.value) {
      // 开启一段断开区间，回看图表在该区间标注“无数据”
      disconnectRanges.value.push({ start: Date.now(), end: null })
    }
    isConnected.value = false
    // 所有测点进入质量 Bad 状态，实时卡片质量码可见，但不产生新采样
    getAllVariableNodes().forEach(node => {
      node.quality = 'Bad'
      const dv = realTimeData.value.get(node.id)
      if (dv) dv.quality = 'Bad'
    })
  }

  // 裁剪超出 1 小时保留窗口的断开区间
  function pruneDisconnectRanges() {
    const cutoff = Date.now() - HISTORY_RETENTION_MS
    disconnectRanges.value = disconnectRanges.value.filter(r => (r.end ?? Date.now()) >= cutoff)
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
    disconnectRanges,
    playbackPickRequest,
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
    getNumericNodes,
    getSamples,
    requestPlaybackPick,
    // 计算属性
    activeAlarmsCount,
    criticalAlarmsCount
  }
})
