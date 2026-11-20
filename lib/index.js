/**
 * dsh-serial · Host 半区
 *
 * 给 DSH Web GUI 增加一个真正的串口终端：枚举本机串口 → 设置线路参数 →
 * 打开设备 → SSE 下行推流 / HTTP 上行写字节。数据面全部留在 Host 进程里，
 * 前端切页、刷新、关面板都不会断开串口会话。
 *
 * 设计要点：
 * - 线路参数交给 `stty(1)`（见 engine.js 顶部注释），Node 侧只做 fd 读写。
 * - 下行用 Server-Sent Events 而不是 WebSocket：零第三方依赖，且浏览器断线后
 *   带 `from=<seq>` 重连即可从环形缓冲补齐，天然支持面板重挂载。
 * - 路由只接受同源请求：串口是宿主机的物理设备，不能被跨站页面驱动。
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAUDS, SerialManager } from './engine.js'

/** 插件名（cordis 标识）。 */
export const name = 'serial'
/** 依赖的 Host 服务。 */
export const inject = ['webServer']

/** 路由前缀。 */
const API = '/api/dsh-serial'
/** 资源目录（xterm 随包分发，避免依赖 profile 里是否装了 @xterm）。 */
const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url))

/** SSE 心跳间隔，避免中间代理掐掉长连接。 */
const HEARTBEAT_MS = 15000

/** 默认线路参数：DSH 调试场景里 921600 最常见（Amlogic/全志开发板控制台默认值）。 */
const DEFAULT_BAUD = 921600
/** 默认线路参数之外的观察时长（测试连接）。 */
const DEFAULT_PROBE_MS = 1500

/** 随包分发的静态资源白名单。 */
const ASSET_FILES = ['xterm.js', 'xterm.css', 'addon-fit.js', 'XTERM-LICENSE']
/** 插件版本号，出现在 /ports 响应里，便于确认热重载是否生效。 */
const PLUGIN_VERSION = '0.2.1'

/**
 * 终端字体策略。
 *
 * 字体按「就近优先」暴露给浏览器：
 *   1. 浏览器首选 "Monaco" —— 本机（如 macOS）装了就直接用，零下载；
 *   2. 本机没有时，由 Host 下发字体目录里的字体文件（随包自带或用户投放）；
 *   3. 都没有时再联网下载一个 OFL 开源等宽字体顶上（默认 Source Code Pro，制表符/块元素齐全）。
 *
 * 字体文件统一放在 <DSH_HOME>/dsh-serial/fonts/：既是投放目录，也是下载缓存。
 */
const FONT_ALIAS = 'DshSerialMono'
const FONT_EXTENSIONS = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' }
/**
 * 默认下载源：全部为 SIL OFL 授权，可安全分发；按顺序尝试。
 *
 * 刻意使用**完整 TTF**而不是 Google Fonts 的 latin 子集（woff2 子集约 11-23 KB）：
 * 终端输出大量使用制表符（U+2500–257F）和块元素（U+2580–259F），
 * 子集里没有这些字形，会掉到别的字体上渲染，导致表格/进度条错位。
 * 实测字形覆盖：Source Code Pro 制表符 128/128、块元素 32/32。
 */
const FONT_SOURCES = [
  {
    label: 'Source Code Pro',
    file: 'SourceCodePro-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/sourcecodepro/SourceCodePro%5Bwght%5D.ttf',
  },
  {
    label: 'Fira Mono',
    file: 'FiraMono-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/firamono/FiraMono-Regular.ttf',
  },
  {
    label: 'JetBrains Mono',
    file: 'JetBrainsMono-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
  },
]
/** 字体的可选覆盖：DSH_SERIAL_FONT_URL 指向自有/已授权的字体文件（例如自己买的 Monaco）。 */
const FONT_OVERRIDE_URL = process.env.DSH_SERIAL_FONT_URL?.trim() ?? ''

/** 字体目录（用户投放 + 下载缓存），可写。 */
function fontDirectory() {
  const home = process.env.DSH_HOME?.trim()
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), 'dsh-serial', 'fonts')
}

/**
 * 随包分发的字体目录（只读）。
 *
 * 插件随包自带的字体目录：字体直接放在 lib/assets/fonts/，安装后无需任何配置，
 * 也不依赖联网下载。分包时不带此目录也属正常——此时会退回用户目录或联网下载。
 * @returns 该目录的绝对路径。
 */
function bundledFontDirectory() {
  return fileURLToPath(new URL('./assets/fonts/', import.meta.url))
}

/**
 * 合并两个字体来源，用户目录优先。
 *
 * 顺序很重要：用户后来自己放的字体（例如换了另一版 Monaco）要能覆盖包内自带的，
 * 所以 DSH_HOME 下的文件排在前面。
 * @returns 字体文件列表 `{name, path, bundled}`。
 */
function listFontFiles() {
  const files = []
  for (const [directory, bundled] of [[fontDirectory(), false], [bundledFontDirectory(), true]]) {
    let entries
    try {
      entries = readdirSync(directory)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!Object.hasOwn(FONT_EXTENSIONS, extname(name).toLowerCase())) continue
      files.push({ name, path: join(directory, name), bundled })
    }
  }
  return files
}

/** 在字体目录里找现成的字体文件：用户投放的优先，其次下载缓存。 */
function findFontFile() {
  const candidates = listFontFiles()
  if (candidates.length === 0) return undefined
  // 名字含 monaco 的优先（用户自备或包内自带的 Monaco），否则取第一个
  const preferred = candidates.find((candidate) => /monaco/i.test(candidate.name)) ?? candidates[0]
  return { path: preferred.path, name: preferred.name }
}

/**
 * 找一款与主字体不同的字体作为「字形回退」。
 *
 * 为什么需要：用户自备的 Monaco 只有 358 个字形（ASCII + Latin-1 齐全），
 * 制表符 U+2500-257F、块元素、箭头、CJK 全部缺失。终端画表格/进度条、输出中文时
 * 必须有另一款覆盖更全的等宽字体兜底，否则会掉成方框。
 * @param primary - 主字体文件信息。
 * @returns 回退字体文件信息，没有则 undefined。
 */
function findFallbackFontFile(primary) {
  const candidates = listFontFiles()
    .filter((candidate) => primary === undefined || candidate.path !== primary.path)
  // 优先挑非 monaco 的（即字形更全的 OFL 字体）
  const preferred = candidates.find((candidate) => !/monaco/i.test(candidate.name)) ?? candidates[0]
  if (preferred === undefined) return undefined
  return { path: preferred.path, name: preferred.name, label: prettyFontLabel(preferred.name) }
}

/** 并发保护：同一时刻只跑一次下载。 */
let fontDownloadPromise

/**
 * 确保字体目录里有可用字体：有就直接用，没有就按 FONT_SOURCES 顺序下载。
 * @returns {{path: string, name: string, source: string, label: string}}
 */
async function ensureFontFile() {
  const existing = findFontFile()
  if (existing !== undefined) {
    return { path: existing.path, name: existing.name, source: 'local', label: prettyFontLabel(existing.name) }
  }
  if (fontDownloadPromise === undefined) {
    fontDownloadPromise = downloadFont().finally(() => {
      fontDownloadPromise = undefined
    })
  }
  return fontDownloadPromise
}

/**
 * 确保「主字体 + 字形回退字体」都就位。
 * 主字体缺失时下载 OFL 字体顶上；回退字体缺失时也补一个 OFL 字体。
 * @returns {{primary: object, fallback: object|undefined}}
 */
async function ensureFonts() {
  let primary = findFontFile()
  if (primary === undefined) {
    // 只有连随包字体都没有时才需要联网下载
    const downloaded = await ensureFontFile()
    primary = { path: downloaded.path, name: downloaded.name, label: downloaded.label }
  }
  let fallback = findFallbackFontFile(primary)
  if (fallback === undefined) {
    try {
      await downloadFont()
    } catch {
      // 回退字体下载失败不致命：浏览器还有系统等宽字体可用。
    }
    fallback = findFallbackFontFile(primary)
  }
  return { primary, fallback }
}

/** 从文件名猜一个给人看的字体名。 */
function prettyFontLabel(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/-regular$/, '')
  const known = FONT_SOURCES.find((source) => source.file === fileName)
  if (known !== undefined) return known.label
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

/** 依次尝试下载源，成功一个就返回。 */
async function downloadFont() {
  const directory = fontDirectory()
  mkdirSync(directory, { recursive: true, mode: 0o755 })
  const sources = FONT_OVERRIDE_URL === ''
    ? FONT_SOURCES
    : [{ label: prettyFontLabel(FONT_OVERRIDE_URL.split('/').pop() ?? 'custom'), file: 'custom-font.woff2', url: FONT_OVERRIDE_URL }]
  const failures = []
  for (const source of sources) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(20000) })
      if (!response.ok) {
        failures.push(`${source.label}: HTTP ${response.status}`)
        continue
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length < 2048) {
        failures.push(`${source.label}: 文件过小（${bytes.length}B）`)
        continue
      }
      const target = join(directory, source.file)
      writeFileSync(target, bytes)
      return { path: target, name: source.file, source: 'downloaded', label: source.label, bytes: bytes.length }
    } catch (error) {
      failures.push(`${source.label}: ${error.message}`)
    }
  }
  throw new Error(`没有可用字体，且下载失败：${failures.join('；')}`)
}

/** 允许单次 write 的最大字节数（防止误粘贴整文件打爆串口）。 */
const MAX_WRITE_BYTES = 64 * 1024

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** 把一个字体文件信息整理成给前端的载荷。 */
function toFontPayload(file) {
  if (file === undefined) return null
  return { label: prettyFontLabel(file.name), name: file.name, alias: FONT_ALIAS, bytes: file.bytes }
}

/** 下发一个字体文件；没有则 404。 */
function serveFontFile(res, file) {
  if (file === undefined || !existsSync(file.path)) return writeJson(res, 404, { error: '尚未安装字体' })
  const type = FONT_EXTENSIONS[extname(file.path).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'public, max-age=3600',
    'x-dsh-serial-font': encodeURIComponent(prettyFontLabel(file.name)),
  })
  createReadStream(file.path).pipe(res)
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** 读取请求体并解析 JSON；超过上限或解析失败返回 undefined。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 同源校验：拒绝跨站页面驱动本机串口。
 *
 * 这里不强制 loopback —— DSH 常见部署是 dsh 监听 127.0.0.1、由同机的 token 代理
 * 对外提供页面，此时 remoteAddress 是代理地址而非 127.0.0.1。同源 + 非跨站
 * 的判定已经足以挡住 CSRF / 恶意页面。
 */
function isSameOriginRequest(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

/** base64 → Buffer，非法输入抛错。 */
function decodeBase64(value) {
  if (typeof value !== 'string') throw new Error('data 必须是 base64 字符串')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > MAX_WRITE_BYTES) throw new Error(`单次写入超过 ${MAX_WRITE_BYTES} 字节`)
  return bytes
}

/** 线路参数白名单整理。 */
function normalizeOptions(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const baud = Number(source.baud ?? DEFAULT_BAUD)
  const dataBits = Number(source.dataBits ?? 8)
  const stopBits = Number(source.stopBits ?? 1)
  const parity = String(source.parity ?? 'none')
  const flow = String(source.flow ?? 'none')
  return {
    baud: BAUDS.includes(baud) ? baud : DEFAULT_BAUD,
    dataBits: [5, 6, 7, 8].includes(dataBits) ? dataBits : 8,
    stopBits: stopBits === 2 ? 2 : 1,
    parity: ['none', 'even', 'odd'].includes(parity) ? parity : 'none',
    flow: ['none', 'rtscts', 'xonxoff'].includes(flow) ? flow : 'none',
    hangupOnClose: source.hangupOnClose === true,
  }
}

/** 静态资源类型表。 */
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** 服务 ./assets 下的一个文件。 */
function serveAsset(res, file) {
  const target = `${ASSETS}${file}`
  if (!target.startsWith(ASSETS) || !existsSync(target) || !statSync(target).isFile()) {
    writeJson(res, 404, { error: `asset not found: ${file}` })
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'public, max-age=86400',
  })
  createReadStream(target).pipe(res)
}

/**
 * 挂载串口插件。
 * @param ctx - Host 插件上下文（需要 webServer 服务）。
 */
export function apply(ctx) {
  const manager = new SerialManager()

  ctx.effect(() => () => manager.dispose(), 'dsh-serial: engine')

  const routes = [
    {
      kind: 'exact',
      path: `${API}/ports`,
      handler: (req, res) => {
        if (!isSameOriginRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        const ports = manager.list()
        const sessions = manager.active()
        // 会话所在的路径如果不是标准 tty 名（自定义 /dev 名、symlink 等），listPorts 不会列出它，
        // 用户就会看到一个「看不见的占用」。这里把这类路径补进列表，保证占用永远可见。
        const listed = new Set(ports.map((port) => port.path))
        for (const session of sessions) {
          if (listed.has(session.path)) continue
          ports.push({ path: session.path, name: session.path.split('/').pop(), driver: undefined, bus: 'custom', inUse: true })
        }
        writeJson(res, 200, {
          version: PLUGIN_VERSION,
          defaultBaud: DEFAULT_BAUD,
          ports,
          bauds: BAUDS,
          sessions,
          fontAlias: FONT_ALIAS,
          fontReady: findFontFile() !== undefined,
        })
      },
    },
    {
      kind: 'exact',
      path: `${API}/probe`,
      handler: async (req, res) => {
        if (!isSameOriginRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined || typeof body.path !== 'string') {
          return writeJson(res, 400, { error: 'body 需要 { path, baud?, timeoutMs? }' })
        }
        try {
          const result = await manager.probe(body.path, normalizeOptions(body), {
            timeoutMs: Number(body.timeoutMs ?? DEFAULT_PROBE_MS),
          })
          writeJson(res, 200, { result })
        } catch (error) {
          writeJson(res, 400, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/open`,
      handler: async (req, res) => {
        if (!isSameOriginRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined || typeof body.path !== 'string') {
          return writeJson(res, 400, { error: 'body 需要 { path, baud?, dataBits?, parity?, stopBits?, flow? }' })
        }
        try {
          const session = await manager.open(body.path, normalizeOptions(body), {
            // takeover：强制接管同一设备上的旧会话（页面刷新后丢失 sessionId 的残留会话、
            // 或设备拔插留下的僵尸会话）。前端在收到「已被占用」后会带这个标志重试。
            takeover: body.takeover === true,
          })
          writeJson(res, 200, { session })
        } catch (error) {
          writeJson(res, 400, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/write`,
      handler: async (req, res) => {
        if (!isSameOriginRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined || typeof body.session !== 'string') {
          return writeJson(res, 400, { error: 'body 需要 { session, data(base64) }' })
        }
        try {
          writeJson(res, 200, manager.write(body.session, decodeBase64(body.data)))
        } catch (error) {
          writeJson(res, 400, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/set`,
      handler: async (req, res) => {
        if (!isSameOriginRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined || typeof body.session !== 'string') {
          return writeJson(res, 400, { error: 'body 需要 { session, ...线路参数 }' })
        }
        try {
          writeJson(res, 200, { session: await manager.reconfigure(body.session, normalizeOptions(body)) })
        } catch (error) {
          writeJson(res, 400, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/close`,
      handler: async (req, res) => {
        if (!isSameOriginRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (body === undefined || typeof body.session !== 'string') {
          return writeJson(res, 400, { error: 'body 需要 { session }' })
        }
        try {
          writeJson(res, 200, manager.close(body.session))
        } catch (error) {
          writeJson(res, 400, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/stream`,
      handler: (req, res) => {
        if (!isSameOriginRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('session')
        const from = Number(url.searchParams.get('from') ?? '0')
        if (sessionId === null) return writeJson(res, 400, { error: '缺少 session 参数' })
        let session
        try {
          session = manager.find(sessionId)
        } catch (error) {
          return writeJson(res, 404, { error: error.message })
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': connected\n\n')
        session.subscribe(res, Number.isFinite(from) ? from : 0)
        const heartbeat = setInterval(() => {
          try {
            res.write(`event: ping\ndata: ${JSON.stringify({ seq: session.ring.end })}\n\n`)
          } catch {
            clearInterval(heartbeat)
          }
        }, HEARTBEAT_MS)
        if (typeof heartbeat.unref === 'function') heartbeat.unref()
        req.on('close', () => {
          clearInterval(heartbeat)
          session.unsubscribe(res)
        })
      },
    },
    {
      // 主字体：用户自备的 Monaco 优先，没有就是下载来的 OFL 字体
      kind: 'exact',
      path: `${API}/font`,
      handler: async (req, res) => {
        if (!isSameOriginRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
        const method = req.method ?? 'GET'
        if (method === 'GET') return serveFontFile(res, findFontFile())
        // POST：确保主字体 + 字形回退字体都就位，返回两者信息
        if (method === 'POST') {
          try {
            const fonts = await ensureFonts()
            writeJson(res, 200, {
              font: toFontPayload(fonts.primary),
              fallback: fonts.fallback === undefined ? null : toFontPayload(fonts.fallback),
            })
          } catch (error) {
            writeJson(res, 502, { error: error.message })
          }
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    {
      // 字形回退字体：主字体缺失的制表符/块元素/CJK 由它渲染
      kind: 'exact',
      path: `${API}/font/fallback`,
      handler: (req, res) => {
        if (!isSameOriginRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        return serveFontFile(res, findFallbackFontFile(findFontFile()))
      },
    },
    // 静态资源用逐文件 exact 路由：prefix 路由的匹配语义在宿主里不可靠。
    ...ASSET_FILES.map((file) => ({
      kind: 'exact',
      path: `${API}/assets/${file}`,
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        serveAsset(res, file)
      },
    })),
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-serial: routes')
}
