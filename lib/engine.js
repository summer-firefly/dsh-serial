/**
 * dsh-serial · Host 侧串口引擎
 *
 * Node 没有 termios 绑定，所以线路参数（波特率/位宽/校验/流控）统一交给系统的
 * `stty(1)` 设置；termios 状态属于 tty 设备本身，stty 进程退出后依然生效。
 * 数据面用 `O_NONBLOCK` 打开的设备 fd + 轮询 `readSync` 读取：tty 的 fd 不能交给
 * `net.Socket`（Node 会报 "Unsupported fd type: TTY"），而阻塞读会长期占用 libuv
 * 线程池，因此非阻塞读 + 短间隔 drain 是本机上最稳的做法。
 */
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeSync,
} from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

/** 轮询间隔（毫秒）。串口控制台 6ms 足够，且几乎不占 CPU。 */
const POLL_INTERVAL_MS = 6
/** 每个会话保留的回放缓冲上限（字节），超出后丢弃最旧数据。 */
const RING_CAPACITY = 512 * 1024
/** 单次 read 的最大字节数。 */
const READ_CHUNK = 64 * 1024
/** 常见波特率，供 UI 下拉选择。 */
export const BAUDS = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1500000, 2000000, 3000000,
]
/** 允许打开的设备路径形态：只放行 /dev 下的简单设备名。 */
const PORT_PATH_RE = /^\/dev\/[A-Za-z0-9._/-]+$/

/** 把 stty 参数解析成 argv 的公共部分。 */
function sttyArgs(path, options) {
  const dataBits = Number(options.dataBits ?? 8)
  const parity = String(options.parity ?? 'none')
  const stopBits = Number(options.stopBits ?? 1)
  const flow = String(options.flow ?? 'none')
  const args = ['-F', path, String(Number(options.baud ?? 115200))]
  args.push(`cs${[5, 6, 7, 8].includes(dataBits) ? dataBits : 8}`)
  if (parity === 'none') {
    args.push('-parenb')
  } else {
    args.push('parenb', parity === 'even' ? '-parodd' : 'parodd')
  }
  args.push(stopBits === 2 ? 'cstopb' : '-cstopb')
  if (flow === 'rtscts') args.push('crtscts')
  else if (flow === 'xonxoff') args.push('-crtscts', 'ixon', 'ixoff')
  else args.push('-crtscts', '-ixon', '-ixoff')
  // raw：不做任何行处理（不转换 CR/LF、不解释 ^C/^D），终端对端自己决定语义。
  args.push('raw', '-echo', 'clocal')
  // 默认 -hupcl：关闭端口时不拉低 DTR。很多开发板的 DTR 接了自动复位电路，
  // 保持 DTR 电平可以在关闭/重开串口时避免意外复位板子。
  args.push(options.hangupOnClose === true ? 'hupcl' : '-hupcl')
  return args
}

/** 以 Promise 形式跑 stty。 */
export function applyStty(path, options) {
  return new Promise((resolve, reject) => {
    execFile('stty', sttyArgs(path, options), { timeout: 5000 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const detail = String(stderr || '').trim() || error.message
      reject(new Error(`stty 失败（${path}）：${detail}`))
    })
  })
}

/** 读取一个符号链接指向的 basename，失败返回 undefined。 */
function linkBase(path) {
  try {
    return readlinkSync(path).split('/').filter(Boolean).pop()
  } catch {
    return undefined
  }
}

/** 从 /sys 读出 tty 设备的驱动名与 USB 身份信息。 */
function describePort(path) {
  const name = path.replace('/dev/', '')
  const info = { path, name, driver: undefined, bus: 'unknown', vid: undefined, pid: undefined, product: undefined, manufacturer: undefined }
  const sysTty = `/sys/class/tty/${name}`
  if (!existsSync(sysTty)) return info
  const driver = linkBase(`${sysTty}/device/driver`)
  if (driver !== undefined) info.driver = driver
  if (driver !== undefined && /usb|acm|ch34|cp210|ftdi|pl2303/i.test(driver)) {
    // 走真实路径向上找带 idVendor 的那一级（USB 设备节点）。
    let level
    try {
      level = realpathSync(`${sysTty}/device`)
    } catch {
      level = undefined
    }
    for (let depth = 0; level !== undefined && depth < 5; depth += 1) {
      if (existsSync(`${level}/idVendor`)) {
        info.bus = 'usb'
        info.vid = readText(`${level}/idVendor`)
        info.pid = readText(`${level}/idProduct`)
        info.product = readText(`${level}/product`)
        info.manufacturer = readText(`${level}/manufacturer`)
        break
      }
      const parent = dirname(level)
      if (parent === level) break
      level = parent
    }
  } else if (name.startsWith('ttyS')) {
    info.bus = 'uart'
  }
  return info
}

/**
 * 把一段原始字节整理成「给人看」的样本：抹掉控制字符、压掉多余空行、截断。
 * @param bytes - 原始字节。
 * @returns 可读字符串（可能为空）。
 */
function printableSample(bytes) {
  if (bytes.length === 0) return ''
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '')
  return lines.join('\n').slice(-400)
}

/**
 * 可打印字符占比：用来区分「对端真的在说话」和「波特率错了收到的乱码」。
 * 错误波特率下线路同样会有字节，但几乎全是不可打印的高位字节。
 * @param bytes - 原始字节。
 * @returns 0..1 的比例。
 */
function readableRatio(bytes) {
  if (bytes.length === 0) return 0
  let printable = 0
  for (const byte of bytes) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x0a || byte === 0x0d || byte === 0x09) printable += 1
  }
  return printable / bytes.length
}

/** 读一个 sysfs 文本属性（自动去空白，缺失时返回 undefined）。 */
function readText(file) {
  try {
    return readFileSync(file, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** 列出本机可疑的串口设备（USB 优先），附带占用状态。 */
export function listPorts(inUse) {
  const found = []
  let names = []
  try {
    names = readdirSync('/dev')
  } catch {
    return found
  }
  for (const name of names) {
    if (!/^tty(USB|ACM)\d+$/.test(name) && !/^ttyS\d+$/.test(name) && !/^rfcomm\d+$/.test(name)) continue
    found.push(describePort(`/dev/${name}`))
  }
  const rank = (port) => (port.bus === 'usb' ? 0 : port.bus === 'uart' ? 1 : 2)
  found.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
  return found.map((port) => ({ ...port, inUse: inUse.has(port.path) }))
}

/** 环形回放缓冲：按字节序号寻址，便于前端断线重连后补齐。 */
class Ring {
  constructor(capacity) {
    this.capacity = capacity
    this.chunks = []
    this.length = 0
    /** 缓冲区第一个字节的全局序号。 */
    this.start = 0
    /** 已写入的全局字节总数。 */
    this.end = 0
  }

  push(chunk) {
    this.chunks.push(chunk)
    this.length += chunk.length
    this.end += chunk.length
    while (this.length > this.capacity && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      this.length -= dropped.length
      this.start += dropped.length
    }
  }

  /** 取出从 from 起的数据；from 早于缓冲起点时从起点开始。 */
  since(from) {
    const begin = Math.max(Number.isFinite(from) ? from : 0, this.start)
    if (begin >= this.end) return Buffer.alloc(0)
    const merged = Buffer.concat(this.chunks)
    return merged.subarray(begin - this.start)
  }
}

/** 一个打开的串口会话。 */
class SerialSession {
  constructor(manager, path, options) {
    this.id = randomUUID()
    this.path = path
    this.options = { ...options }
    this.fd = undefined
    this.ring = new Ring(RING_CAPACITY)
    this.subscribers = new Set()
    this.timer = undefined
    this.closed = false
    this.error = undefined
    this.openedAt = Date.now()
    /** 上次检查设备节点是否还在的时间戳（节流用）。 */
    this.lastLivenessCheck = 0
    this.manager = manager
  }

  /**
   * 会话是否还活着：未被关闭，且设备节点依然存在。
   *
   * 这一条是必需的：CH341 之类 USB 转串口被拔掉后，内核会让 /dev/ttyUSB0 消失，
   * 但已打开 fd 上的 read 往往只返回 EAGAIN 而不报错 —— 光靠读错误发现不了，
   * 会话就会变成僵尸，永久占着设备路径不让重新打开。
   * @returns 是否可用。
   */
  isAlive() {
    return !this.closed && existsSync(this.path)
  }

  async open() {
    if (!PORT_PATH_RE.test(this.path)) throw new Error(`非法设备路径：${this.path}`)
    if (!existsSync(this.path)) throw new Error(`设备不存在：${this.path}`)
    await applyStty(this.path, this.options)
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK)
    this.timer = setInterval(() => this.drain(), POLL_INTERVAL_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 把内核缓冲里的数据全部读空。 */
  drain() {
    if (this.closed || this.fd === undefined) return
    // 每秒确认一次设备节点还在，及时发现「设备被拔掉但 fd 还开着」的僵尸会话。
    const now = Date.now()
    if (now - this.lastLivenessCheck > 1000) {
      this.lastLivenessCheck = now
      if (!existsSync(this.path)) {
        this.fail(new Error(`设备已断开：${this.path} 节点消失（USB 转串口被拔出？）`))
        return
      }
    }
    const buffer = Buffer.alloc(READ_CHUNK)
    for (;;) {
      let count
      try {
        count = readSync(this.fd, buffer, 0, buffer.length, null)
      } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return
        if (error.code === 'EINTR') continue
        this.fail(new Error(`读取串口失败：${error.message}`))
        return
      }
      if (count <= 0) return
      const chunk = Buffer.from(buffer.subarray(0, count))
      this.ring.push(chunk)
      this.broadcast({ type: 'data', seq: this.ring.end, bytes: chunk.toString('base64') })
    }
  }

  /** 向串口写入字节。 */
  write(bytes) {
    if (this.closed || this.fd === undefined) throw new Error('串口未打开')
    let offset = 0
    let guard = 0
    while (offset < bytes.length) {
      try {
        offset += writeSync(this.fd, bytes, offset, bytes.length - offset)
      } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') {
          // 输出缓冲满：极小概率（写入都很短），短暂自旋后重试，避免丢字节。
          guard += 1
          if (guard > 500) throw new Error('串口写入阻塞超时')
          continue
        }
        if (error.code === 'EINTR') continue
        throw new Error(`写入串口失败：${error.message}`)
      }
    }
  }

  /** 运行期修改线路参数。 */
  async reconfigure(options) {
    this.options = { ...this.options, ...options }
    await applyStty(this.path, this.options)
    this.broadcast({ type: 'params', options: this.options })
  }

  subscribe(res, from) {
    this.subscribers.add(res)
    const backlog = this.ring.since(from)
    if (backlog.length > 0) {
      res.write(`data: ${JSON.stringify({ type: 'data', seq: this.ring.end, bytes: backlog.toString('base64') })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({ type: 'ready', sessionId: this.id, path: this.path, options: this.options, seq: this.ring.end })}\n\n`)
  }

  unsubscribe(res) {
    this.subscribers.delete(res)
  }

  broadcast(frame) {
    const line = `data: ${JSON.stringify(frame)}\n\n`
    for (const res of this.subscribers) {
      try {
        res.write(line)
      } catch {
        this.subscribers.delete(res)
      }
    }
  }

  fail(error) {
    this.error = error.message
    this.broadcast({ type: 'closed', error: error.message })
    this.dispose()
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd)
      } catch {}
      this.fd = undefined
    }
    for (const res of this.subscribers) {
      try {
        res.end()
      } catch {}
    }
    this.subscribers.clear()
    this.manager.forget(this.path, this.id)
  }

  snapshot() {
    return {
      sessionId: this.id,
      path: this.path,
      options: this.options,
      openedAt: this.openedAt,
      buffered: this.ring.length,
      seq: this.ring.end,
      error: this.error,
    }
  }
}

/** 会话管理器：同一设备只允许一个活动会话。 */
export class SerialManager {
  constructor() {
    /** @type {Map<string, SerialSession>} */
    this.sessions = new Map()
    /** @type {Map<string, string>} */
    this.byPath = new Map()
  }

  /** 已被占用的设备路径集合。 */
  busyPaths() {
    return new Set(this.byPath.keys())
  }

  /**
   * 清理僵尸会话：设备节点已经不存在、但 fd 还开着的会话。
   * 读写错误探测不到这种情况（read 只返回 EAGAIN），所以必须按节点存在性判断。
   * @returns 被清理掉的会话数。
   */
  reap() {
    let reaped = 0
    for (const [sessionId, session] of [...this.sessions]) {
      if (session.isAlive()) continue
      session.dispose()
      this.sessions.delete(sessionId)
      this.byPath.delete(session.path)
      reaped += 1
    }
    return reaped
  }

  list() {
    this.reap()
    return listPorts(this.busyPaths())
  }

  active() {
    this.reap()
    return [...this.sessions.values()].map((session) => session.snapshot())
  }

  find(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error(`会话不存在：${sessionId}`)
    return session
  }

  /**
   * 打开串口，返回会话。
   * @param path - 设备路径。
   * @param options - 线路参数。
   * @param config - `takeover` 为真时先关掉同一设备上的旧会话（僵尸或残留会话）。
   */
  async open(path, options, config = {}) {
    this.reap()
    const existing = this.byPath.get(path)
    if (existing !== undefined) {
      if (config.takeover !== true) {
        throw new Error(`${path} 已被另一个会话占用`)
      }
      const stale = this.sessions.get(existing)
      if (stale !== undefined) {
        stale.dispose()
        this.sessions.delete(existing)
      }
      this.byPath.delete(path)
    }
    const session = new SerialSession(this, path, options)
    await session.open()
    this.sessions.set(session.id, session)
    this.byPath.set(path, session.id)
    return session.snapshot()
  }

  close(sessionId) {
    const session = this.find(sessionId)
    session.dispose()
    this.sessions.delete(sessionId)
    return { closed: sessionId }
  }

  write(sessionId, bytes) {
    this.find(sessionId).write(bytes)
    return { written: bytes.length }
  }

  async reconfigure(sessionId, options) {
    const session = this.find(sessionId)
    await session.reconfigure(options)
    return session.snapshot()
  }

  /**
   * 测试连接：确认端口能按给定参数打开，并观察线路上有没有数据。
   *
   * - 该端口已有会话时复用现有会话，只发一个回车并统计后续字节，不动会话本身。
   * - 没有会话时开一个临时会话探测，探完立刻关闭，不留状态。
   *
   * @param path - 设备路径。
   * @param options - 线路参数。
   * @param config - `timeoutMs` 观察时长，`sendProbe` 是否先发一个回车。
   * @returns 探测结论：是否可打开、收到多少字节、可读样本。
   */
  async probe(path, options, config = {}) {
    const timeoutMs = Math.min(Math.max(Number(config.timeoutMs ?? 1500), 200), 8000)
    const sendProbe = config.sendProbe !== false
    this.reap()
    const startedAt = Date.now()
    const existingId = this.byPath.get(path)
    let session
    let temporary = false

    if (existingId !== undefined) {
      session = this.sessions.get(existingId)
    } else {
      if (!PORT_PATH_RE.test(path)) throw new Error(`非法设备路径：${path}`)
      if (!existsSync(path)) throw new Error(`设备不存在：${path}`)
      session = new SerialSession(this, path, options)
      await session.open()
      temporary = true
    }

    try {
      const before = session.ring.end
      if (sendProbe) session.write(Buffer.from('\r\n'))
      await new Promise((resolve) => {
        // 不 unref：探测是一段短暂的等待，必须真的把事件循环顶住才会返回结论。
        setTimeout(resolve, timeoutMs)
      })
      const received = session.ring.end - before
      const raw = session.ring.since(before)
      const ratio = readableRatio(raw)
      return {
        ok: true,
        port: path,
        baud: session.options.baud,
        reused: !temporary,
        elapsedMs: Date.now() - startedAt,
        received,
        readableRatio: Number(ratio.toFixed(3)),
        sample: printableSample(raw),
        // active: 收到可读文本（对端在说话）；garbled: 有字节但读不出来（多半波特率/校验不符）；
        // silent: 一个字节都没有（对端没在输出，或需要先敲回车）。
        verdict: received === 0 ? 'silent' : ratio >= 0.85 ? 'active' : 'garbled',
      }
    } finally {
      if (temporary) session.dispose()
    }
  }

  forget(path, sessionId) {
    // 只清理确实属于该会话的映射：临时探测会话不能误删真实会话的占用标记。
    if (sessionId !== undefined && this.byPath.get(path) !== sessionId) return
    this.byPath.delete(path)
  }

  dispose() {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    this.byPath.clear()
  }
}
