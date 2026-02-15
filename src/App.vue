<script setup>
import { ref, computed, onMounted } from 'vue'
import { t, initLocale } from './i18n.js'

const STORAGE_KEY = 'ip-scanner-selected-iface'
const CACHE_KEY = 'ip-scanner-cache'
const AUTO_RESCAN_MS = 5 * 60 * 1000 // 5 minutes

const interfaces = ref([])
const selectedIface = ref('')
const subnet = ref('')
const neighbors = ref([])
const searchQuery = ref('')
const selectedStates = ref(['REACHABLE', 'LOCAL'])
const showIPv4 = ref(true)
const showIPv6 = ref(false)
const scanning = ref(false)
const loading = ref(false)
const error = ref('')
const scanProgress = ref(0)
const scanPhase = ref('')
const lastScanTime = ref(null)
const tick = ref(0)

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      iface: selectedIface.value,
      neighbors: neighbors.value,
      subnet: subnet.value,
      time: Date.now(),
    }))
  } catch { /* quota exceeded, ignore */ }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function formatTimeAgo(ts) {
  if (!ts) return ''
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return t('timeAgoSeconds', { n: diff })
  if (diff < 3600) return t('timeAgoMinutes', { n: Math.floor(diff / 60) })
  return t('timeAgoHours', { n: Math.floor(diff / 3600) })
}

const lastScanLabel = computed(() => { void tick.value; return formatTimeAgo(lastScanTime.value) })

function cockpitSpawn(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = cockpit.spawn(args, { superuser: 'try', err: 'message', ...opts })
    proc.done((data) => resolve(data))
    proc.fail((ex, data) => reject(new Error(data || ex.message || 'Command failed')))
  })
}

async function loadInterfaces() {
  try {
    const raw = await cockpitSpawn(['ip', '-j', 'link'])
    const links = JSON.parse(raw)
    interfaces.value = links.filter(
      (l) => l.ifname !== 'lo' && l.operstate === 'UP'
    )
    if (interfaces.value.length > 0) {
      const cached = localStorage.getItem(STORAGE_KEY)
      if (cached && interfaces.value.some((i) => i.ifname === cached)) {
        selectedIface.value = cached
      } else {
        selectedIface.value = interfaces.value[0].ifname
      }

      // Restore cached scan data
      const cache = loadCache()
      if (cache && cache.iface === selectedIface.value && cache.neighbors?.length > 0) {
        neighbors.value = cache.neighbors
        subnet.value = cache.subnet || ''
        lastScanTime.value = cache.time

        // Auto-rescan if cache is stale
        const age = Date.now() - cache.time
        if (age > AUTO_RESCAN_MS) {
          await onIfaceChange()
          await startScan()
        } else {
          await onIfaceChange(true) // skip loadNeighbors, just detect subnet
        }
      } else {
        await onIfaceChange()
      }
    }
  } catch (e) {
    error.value = t('errLoadInterfaces') + e.message
  }
}

async function onIfaceChange(skipNeighbors = false) {
  if (!selectedIface.value) return
  localStorage.setItem(STORAGE_KEY, selectedIface.value)
  try {
    const raw = await cockpitSpawn(['ip', '-j', 'addr', 'show', selectedIface.value])
    const addrs = JSON.parse(raw)
    const iface = addrs[0]
    if (iface && iface.addr_info) {
      const ipv4 = iface.addr_info.find((a) => a.family === 'inet')
      const ipv6 = iface.addr_info.find((a) => a.family === 'inet6' && !a.local.startsWith('fe80'))
      const parts = []
      if (ipv4) parts.push(calcNetwork(ipv4.local, ipv4.prefixlen) + '/' + ipv4.prefixlen)
      if (ipv6) parts.push(ipv6.local + '/' + ipv6.prefixlen)
      subnet.value = parts.length > 0 ? parts.join(' | ') : t('noIpAddress')
    }
    if (!skipNeighbors) await loadNeighbors()
  } catch (e) {
    error.value = t('errDetectSubnet') + e.message
  }
}

function calcNetwork(ip, prefix) {
  const parts = ip.split('.').map(Number)
  const ipNum = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  const net = (ipNum & mask) >>> 0
  return [
    (net >>> 24) & 0xff,
    (net >>> 16) & 0xff,
    (net >>> 8) & 0xff,
    net & 0xff,
  ].join('.')
}

function isIPv6(ip) {
  return ip.includes(':')
}

async function loadNeighbors() {
  try {
    loading.value = true
    const raw = await cockpitSpawn(['ip', '-j', 'neigh', 'show', 'dev', selectedIface.value])
    const data = JSON.parse(raw)
    const entries = data
      .filter((n) => n.dst && n.state && n.state[0] !== 'FAILED' && n.state[0] !== 'INCOMPLETE' && n.lladdr)

    // Group by MAC to merge IPv4/IPv6 from the same device
    const byMac = new Map()
    for (const n of entries) {
      const mac = n.lladdr
      const family = isIPv6(n.dst) ? 'IPv6' : 'IPv4'
      const state = n.state ? n.state[0] : 'UNKNOWN'
      if (!byMac.has(mac)) {
        byMac.set(mac, { mac, ipv4: null, ipv6: null, state: 'STALE' })
      }
      const device = byMac.get(mac)
      if (family === 'IPv4') device.ipv4 = n.dst
      else device.ipv6 = n.dst
      if (state === 'REACHABLE' || device.state !== 'REACHABLE') {
        device.state = state
      }
    }

    // Add local machine to the list
    try {
      const addrRaw = await cockpitSpawn(['ip', '-j', 'addr', 'show', selectedIface.value])
      const addrData = JSON.parse(addrRaw)
      const iface = addrData[0]
      if (iface) {
        const localMac = iface.address
        const localIpv4 = iface.addr_info?.find((a) => a.family === 'inet')?.local
        const localIpv6 = iface.addr_info?.find((a) => a.family === 'inet6' && !a.local.startsWith('fe80'))?.local
        if (localMac && (localIpv4 || localIpv6)) {
          byMac.set(localMac, { mac: localMac, ipv4: localIpv4 || null, ipv6: localIpv6 || null, state: 'LOCAL' })
        }
      }
    } catch { /* ignore */ }

    neighbors.value = [...byMac.values()]
      .map((d) => ({
        ip: d.ipv4 || d.ipv6,
        ipv4: d.ipv4,
        ipv6: d.ipv6,
        mac: d.mac,
        state: d.state,
        family: d.ipv4 ? 'IPv4' : 'IPv6',
      }))
      .sort((a, b) => {
        if (a.ipv4 && b.ipv4) return ipToNum(a.ipv4) - ipToNum(b.ipv4)
        if (a.ipv4) return -1
        if (b.ipv4) return 1
        return a.ip.localeCompare(b.ip)
      })

    lastScanTime.value = Date.now()
    saveCache()
  } catch (e) {
    error.value = t('errLoadNeighbors') + e.message
  } finally {
    loading.value = false
  }
}

function ipToNum(ip) {
  const p = ip.split('.').map(Number)
  return (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]
}

async function getDnsServer(iface) {
  // Try resolvectl first (systemd-resolved)
  try {
    const raw = await cockpitSpawn(['resolvectl', 'dns', iface])
    const match = raw.match(/:\s*(.+)/)
    if (match) {
      const server = match[1].trim().split(/\s+/)[0]
      if (server) return server
    }
  } catch { /* ignore */ }

  // Fallback: nmcli
  try {
    const raw = await cockpitSpawn(['nmcli', 'dev', 'show', iface])
    const match = raw.match(/IP4\.DNS\[1\]:\s*(\S+)/)
    if (match) return match[1]
  } catch { /* ignore */ }

  // Fallback: /etc/resolv.conf (system default)
  try {
    const raw = await cockpitSpawn(['bash', '-c', "grep '^nameserver' /etc/resolv.conf | head -1 | awk '{print $2}'"])
    const server = raw.trim()
    if (server) return server
  } catch { /* ignore */ }

  return null
}

async function resolveHostname(ip, dnsServer) {
  try {
    const args = dnsServer
      ? ['dig', '-x', ip, '@' + dnsServer, '+short', '+timeout=2', '+tries=1']
      : ['dig', '-x', ip, '+short', '+timeout=2', '+tries=1']
    const raw = await cockpitSpawn(args)
    const hostname = raw.trim().replace(/\.$/, '')
    return hostname || ''
  } catch {
    return ''
  }
}

async function resolveAllHostnames(neighborsList, dnsServer) {
  await Promise.allSettled(
    neighborsList.map(async (n) => {
      const ip = n.ipv4 || n.ipv6
      if (ip) {
        n.hostname = await resolveHostname(ip, dnsServer)
      }
    })
  )
}

async function startScan() {
  if (!selectedIface.value || !subnet.value || subnet.value === t('noIpAddress')) return
  scanning.value = true
  error.value = ''
  scanProgress.value = 0
  scanPhase.value = t('initializing')

  try {
    const networkBase = subnet.value.split('/')[0]
    const prefix = parseInt(subnet.value.split('/')[1])
    const parts = networkBase.split('.')
    const baseNet = parts.slice(0, 3).join('.')

    if (prefix > 24) {
      scanPhase.value = t('subnetTooSmall')
      scanning.value = false
      return
    }

    scanProgress.value = 10
    scanPhase.value = t('pinging')

    const progressTimer = setInterval(() => {
      if (scanProgress.value < 85) {
        scanProgress.value += Math.random() * 8
      }
    }, 500)

    try {
      await cockpitSpawn(
        ['fping', '-a', '-g', subnet.value, '-q', '-r', '1'],
        { err: 'ignore' }
      )
    } catch {
      scanPhase.value = t('pingFallback')
      const script = `for i in $(seq 1 254); do ping -c 1 -W 1 ${baseNet}.$i > /dev/null 2>&1 & done; wait`
      await cockpitSpawn(['bash', '-c', script])
    }

    clearInterval(progressTimer)
    scanProgress.value = 85
    scanPhase.value = t('collecting')

    // Wait for ARP table to settle before collecting
    await new Promise((r) => setTimeout(r, 2000))
    scanProgress.value = 90
    await loadNeighbors()

    scanProgress.value = 95
    scanPhase.value = t('resolvingHostnames')
    const dnsServer = await getDnsServer(selectedIface.value)
    await resolveAllHostnames(neighbors.value, dnsServer)
    saveCache()

    scanProgress.value = 100
    scanPhase.value = t('complete')

    setTimeout(() => {
      scanProgress.value = 0
      scanPhase.value = ''
    }, 1500)
  } catch (e) {
    error.value = t('errScanFailed') + e.message
    scanProgress.value = 0
    scanPhase.value = ''
  } finally {
    scanning.value = false
  }
}

const availableStates = computed(() => {
  const states = new Set(neighbors.value.map((n) => n.state))
  return [...states].sort()
})

function toggleState(state) {
  const idx = selectedStates.value.indexOf(state)
  if (idx >= 0) {
    selectedStates.value.splice(idx, 1)
  } else {
    selectedStates.value.push(state)
  }
}

function selectAllStates() {
  selectedStates.value = [...availableStates.value]
}

const filteredNeighbors = computed(() => {
  let result = neighbors.value

  result = result.filter((n) => {
    if (n.ipv4 && showIPv4.value) return true
    if (n.ipv6 && showIPv6.value) return true
    return false
  })

  if (selectedStates.value.length > 0) {
    result = result.filter((n) => selectedStates.value.includes(n.state))
  }

  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(
      (n) =>
        (n.ipv4 && n.ipv4.toLowerCase().includes(q)) ||
        (n.ipv6 && n.ipv6.toLowerCase().includes(q)) ||
        n.mac.toLowerCase().includes(q) ||
        n.state.toLowerCase().includes(q) ||
        (n.hostname && n.hostname.toLowerCase().includes(q))
    )
  }

  return result
})

const stats = computed(() => {
  const total = neighbors.value.length
  const reachable = neighbors.value.filter((n) => n.state === 'REACHABLE').length
  const stale = neighbors.value.filter((n) => n.state === 'STALE').length
  return { total, reachable, stale }
})

function stateClass(state) {
  if (state === 'LOCAL') return 'text-blue-600 bg-blue-50 border-blue-200'
  if (state === 'REACHABLE') return 'text-green-600 bg-green-50 border-green-200'
  if (state === 'STALE') return 'text-orange-600 bg-orange-50 border-orange-200'
  return 'text-gray-600 bg-gray-50 border-gray-200'
}

function stateFilterClass(state) {
  const active = selectedStates.value.includes(state)
  if (state === 'LOCAL') return active ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-white text-gray-500 border-gray-200'
  if (state === 'REACHABLE') return active ? 'bg-green-100 text-green-700 border-green-300' : 'bg-white text-gray-500 border-gray-200'
  if (state === 'STALE') return active ? 'bg-orange-100 text-orange-700 border-orange-300' : 'bg-white text-gray-500 border-gray-200'
  return active ? 'bg-gray-200 text-gray-700 border-gray-400' : 'bg-white text-gray-500 border-gray-200'
}

function stateCount(state) {
  return neighbors.value.filter((n) => n.state === state).length
}

onMounted(() => {
  initLocale()
  loadInterfaces()
  // Update "time ago" display every 30s
  setInterval(() => { tick.value++ }, 30000)
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 p-6">
    <div class="max-w-5xl mx-auto">
      <!-- Header -->
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-gray-900">{{ t('title') }}</h1>
        <p class="text-sm text-gray-500 mt-1">{{ t('subtitle') }}</p>
      </div>

      <!-- Error Alert -->
      <div v-if="error" class="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center justify-between">
        <span>{{ error }}</span>
        <button @click="error = ''" class="text-red-400 hover:text-red-600">&times;</button>
      </div>

      <!-- Controls -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
        <div class="flex flex-wrap items-end gap-4">
          <!-- Interface Selector -->
          <div class="flex-1 min-w-48">
            <label class="block text-sm font-medium text-gray-700 mb-1">{{ t('networkInterface') }}</label>
            <select
              v-model="selectedIface"
              @change="onIfaceChange()"
              class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="" disabled>{{ t('selectInterface') }}</option>
              <option v-for="iface in interfaces" :key="iface.ifname" :value="iface.ifname">
                {{ iface.ifname }} ({{ iface.address }})
              </option>
            </select>
          </div>

          <!-- Subnet Display -->
          <div class="min-w-40">
            <label class="block text-sm font-medium text-gray-700 mb-1">{{ t('detectedSubnet') }}</label>
            <div class="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm text-gray-700 font-mono">
              {{ subnet || '—' }}
            </div>
          </div>

          <!-- Scan Button -->
          <button
            @click="startScan"
            :disabled="scanning || !selectedIface"
            class="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span v-if="scanning" class="flex items-center gap-2">
              <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {{ t('scanning') }}
            </span>
            <span v-else>{{ t('startScan') }}</span>
          </button>
        </div>

        <!-- Last Scan Info -->
        <div v-if="lastScanTime && !scanProgress" class="mt-3 text-xs text-gray-400">
          {{ t('lastScan') }} {{ lastScanLabel }}
        </div>

        <!-- Progress Bar -->
        <div v-if="scanProgress > 0" class="mt-4">
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm text-gray-600">{{ scanPhase }}</span>
            <span class="text-sm font-medium text-blue-600">{{ Math.round(scanProgress) }}%</span>
          </div>
          <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-500 ease-out"
              :class="scanProgress >= 100 ? 'bg-green-500' : 'bg-blue-500'"
              :style="{ width: Math.min(scanProgress, 100) + '%' }"
            ></div>
          </div>
        </div>
      </div>

      <!-- Stats Cards -->
      <div class="grid grid-cols-3 gap-4 mb-6">
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div class="text-sm text-gray-500">{{ t('totalDevices') }}</div>
          <div class="text-2xl font-bold text-gray-900">{{ stats.total }}</div>
        </div>
        <div class="bg-white rounded-lg shadow-sm border border-green-200 p-4">
          <div class="text-sm text-green-600">{{ t('reachable') }}</div>
          <div class="text-2xl font-bold text-green-700">{{ stats.reachable }}</div>
        </div>
        <div class="bg-white rounded-lg shadow-sm border border-orange-200 p-4">
          <div class="text-sm text-orange-600">{{ t('stale') }}</div>
          <div class="text-2xl font-bold text-orange-700">{{ stats.stale }}</div>
        </div>
      </div>

      <!-- Search + Table -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-200">
        <!-- Search + Filters -->
        <div class="p-4 border-b border-gray-200 space-y-3">
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t('searchPlaceholder')"
            class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <!-- IP Version Filter -->
          <div class="flex items-center gap-3">
            <span class="text-xs font-medium text-gray-500">{{ t('protocol') }}</span>
            <label class="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" v-model="showIPv4" class="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <span class="text-xs font-medium" :class="showIPv4 ? 'text-gray-700' : 'text-gray-400'">IPv4</span>
            </label>
            <label class="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" v-model="showIPv6" class="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <span class="text-xs font-medium" :class="showIPv6 ? 'text-gray-700' : 'text-gray-400'">IPv6</span>
            </label>
          </div>

          <!-- State Filter Chips -->
          <div v-if="availableStates.length > 0" class="flex flex-wrap items-center gap-2">
            <span class="text-xs font-medium text-gray-500 mr-1">{{ t('state') }}</span>
            <button
              v-for="state in availableStates"
              :key="state"
              @click="toggleState(state)"
              :class="stateFilterClass(state)"
              class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border cursor-pointer transition-colors"
            >
              {{ state }}
              <span class="text-[10px] opacity-70">({{ stateCount(state) }})</span>
            </button>
            <button
              @click="selectAllStates"
              class="text-xs text-blue-600 hover:text-blue-800 ml-1"
            >
              {{ t('all') }}
            </button>
            <button
              @click="selectedStates = []"
              class="text-xs text-gray-500 hover:text-gray-700"
            >
              {{ t('none') }}
            </button>
          </div>
        </div>

        <!-- Table -->
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-gray-50 border-b border-gray-200">
                <th class="text-left px-4 py-3 font-medium text-gray-600">#</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">{{ t('ipAddress') }}</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">{{ t('hostname') }}</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">{{ t('macAddress') }}</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">{{ t('state') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading" class="border-b border-gray-100">
                <td colspan="5" class="px-4 py-8 text-center text-gray-400">{{ t('loading') }}</td>
              </tr>
              <tr v-else-if="filteredNeighbors.length === 0" class="border-b border-gray-100">
                <td colspan="5" class="px-4 py-8 text-center text-gray-400">
                  {{ neighbors.length === 0 ? t('noDevices') : t('noResults') }}
                </td>
              </tr>
              <tr
                v-for="(n, i) in filteredNeighbors"
                :key="n.mac"
                class="border-b border-gray-100 hover:bg-gray-50 transition-colors"
              >
                <td class="px-4 py-3 text-gray-400">{{ i + 1 }}</td>
                <td class="px-4 py-3 font-mono">
                  <div v-if="n.ipv4" class="text-gray-900">{{ n.ipv4 }}</div>
                  <div v-if="n.ipv6 && showIPv6" class="text-gray-500 text-xs">{{ n.ipv6 }}</div>
                </td>
                <td class="px-4 py-3 text-gray-700">
                  <span v-if="n.hostname" class="text-blue-700">{{ n.hostname }}</span>
                  <span v-else class="text-gray-300">—</span>
                </td>
                <td class="px-4 py-3 font-mono text-gray-700">{{ n.mac }}</td>
                <td class="px-4 py-3">
                  <span :class="stateClass(n.state)" class="inline-block px-2 py-0.5 text-xs font-medium rounded border">
                    {{ n.state }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Table Footer -->
        <div class="px-4 py-3 border-t border-gray-200 text-sm text-gray-500">
          {{ t('showing', { filtered: filteredNeighbors.length, total: neighbors.length }) }}
        </div>
      </div>
    </div>
  </div>
</template>
