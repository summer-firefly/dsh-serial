# dsh-serial

**DeepSeek Harness 的串口终端插件。** 在 Web GUI 里像 minicom / SecureCRT / PuTTY 一样连本机串口设备
（USB 转串口、开发板板载 UART），直接在面板里收发 Linux 命令。

侧边栏多一个「串口」入口，点开就是基于 [xterm.js](https://github.com/xtermjs/xterm.js) 的真实终端：
ANSI 颜色、光标、滚动回放、Tab 补全、粘贴全部可用。

- 以 **profile bundle** 形式挂载，不改 DSH 源码
- 会话跑在 **Host 进程**里，切面板、刷新页面都不掉线
- 线路参数交给系统 `stty(1)`，数据面非阻塞读写，不占用 libuv 线程池

> 要求 dsh `>= 0.2.2-rc.2`（见 `package.json` 的 `dsh.engines`）。

---

## 快速开始

**1. 放置插件目录**

```sh
ln -s /path/to/dsh-serial \
  /var/lib/deepseek-harness/profiles/web/node_modules/dsh-serial
```

**2. 登记到 profile**

编辑 `/var/lib/deepseek-harness/profiles/web/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-serial": "link:/path/to/dsh-serial"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* ...其它 bundle..., */ "dsh-serial" ]
    }
  }
}
```

**3. 打开 GUI**

侧边栏「串口」→ 左侧选端口与波特率 → 点「测试连接」探一下线，或直接「连接」→ 右侧终端敲命令。

本包自带 `cordis.patch.yml`，通过 `insert` 行把自身挂进 profile 的 layer 栈；
`dsh.client` 声明让 Web 端额外加载 `./client` 作为浏览器半区。

---

## 界面

面板为左右分栏，窄屏（< 820px）自动改为上下堆叠。

| 区域 | 内容 |
| --- | --- |
| **左栏 · 设置** | 线路参数、连接 / 测试连接 / 断开、快捷按键、终端外观、收发计数 |
| **右栏 · 终端** | 标签栏（显示当前端口与连接状态）+ xterm 画面 + 底部快捷发送行 |


---

## 功能

| 能力 | 说明 |
| --- | --- |
| **端口枚举** | 扫描 `/dev/ttyUSB*`、`ttyACM*`、`ttyS*`、`rfcomm*`；从 sysfs 读驱动名与 USB `vid:pid`，USB 设备排最前，被占用的端口实时标记 |
| **测试连接** | 不建正式会话：临时打开端口、发一个回车、观察 1.5 s 回读，按**可读字符占比**给出三种结论（见下表）。测完立刻关闭，不影响已连接的会话 |
| **线路参数** | 波特率、数据位、校验、停止位、流控均可调；已连接时「应用参数」热切换 |
| **交互终端** | 键盘输入直通串口，支持 `Ctrl-C`、Tab 补全、粘贴 |
| **会话保活** | 会话在 Host 进程，切走再切回、刷新页面都不断线；重挂载按环形缓冲（512 KB）重放，按字节序号去重，不会重复上屏 |
| **快捷发送** | 底部命令输入行，回车即发（等价于键入并回车），适合粘贴长命令 |
| **快捷按键** | `Ctrl-C`、`Ctrl-D`、`Ctrl-Z`、`Tab`、`Esc`、`回车` 六个一键按钮 |
| **终端外观** | 字号、光标样式、闪烁与闪烁频率可调，改动即时生效并持久化 |
| **收发计数** | 左栏底部实时显示累计收 / 发字节数 |
| **本地回显** | 对端不回声时（例如板子没跑 getty）可勾选，把按键显示在本地 |

### 测试连接的三种结论

插件发出一个回车，观察 1.5 s 内回读到什么，用可读字符占比（`readableRatio`）判断：

| verdict | 条件 | 含义 | 怎么办 |
| --- | --- | --- | --- |
| `active` | 收到字节且可读占比 ≥ 0.85 | 线路正常，对端在说话 | 直接连接 |
| `garbled` | 收到字节但可读占比 < 0.85 | 多半波特率或校验位不对 | 换波特率再试 |
| `silent` | 一个字节都没收到 | 对端没在输出，或需要先敲回车 | 连接后手动敲回车 |

---

## 线路参数

| 参数 | 取值 | 默认 |
| --- | --- | --- |
| 波特率 | 9600 – 3000000，14 档可选 | **921600** |
| 数据位 | 5 / 6 / 7 / 8 | 8 |
| 校验 | 无 / 奇 / 偶 | 无 |
| 停止位 | 1 / 2 | 1 |
| 流控 | 无 / RTS-CTS / XON-XOFF | 无 |

默认取 921600 是因为 DSH 的调试场景里 Amlogic / 全志开发板控制台多用这个速率。

除上述参数外，`stty` 还会固定附加：

- `raw` —— 不做行处理（不转换 CR/LF、不解释 `^C`/`^D`），语义交给对端
- `-echo` —— 不回显，配合「本地回显」开关由前端决定
- `clocal` —— 忽略调制解调器控制线
- `-hupcl` —— 关闭端口时**不拉低 DTR**。很多开发板的 DTR 接了自动复位电路，保持电平可避免关闭/重开串口时意外复位板子

---

## 终端外观

三项偏好都在左栏「终端」分组，改动立刻作用到 xterm，并写入 `localStorage` 的 `dsh-serial:prefs`；
读取时非法值一律回退默认，刷新后保持。

| 选项 | 范围 | 默认 | 实现 |
| --- | --- | --- | --- |
| 字号 | 10 – 28 px | 13 | `term.options.fontSize` + `fit()`，字号变化会改变字符网格，必须重算行列 |
| 光标样式 | 方块 / 下划线 / 竖线 | 方块 | `term.options.cursorStyle` = `block` / `underline` / `bar` |
| 闪烁 | 开 / 关 | 开 | `term.options.cursorBlink` |
| 闪烁频率 | 0.5 – 4 Hz | 1 Hz | 见下 |

**闪烁频率没有官方 API。** xterm 把光标动画写死成 `animation: blink_* 1s step-end infinite`，
所以这里用更高优先级的 CSS 覆盖 `animation-duration: var(--dsr-blink, 1s) !important`，
运行时按频率把 `1000 / Hz` 毫秒写进根元素的 `--dsr-blink`。

改完还要调 `term.refresh(0, rows - 1)` 强制重绘 —— 光标样式与闪烁开关不是每次赋值都立刻触发重绘，
不刷一屏得等下一次闪烁才看得见变化。

---

## 架构

```
浏览器 (xterm.js)                    Host 进程 (Node)                串口设备
  │  POST /api/dsh-serial/write             │                            │
  ├─────────── base64 字节 ────────────────►│  writeSync(fd) ───────────►│
  │                                         │                            │
  │  GET /api/dsh-serial/stream (SSE)       │  轮询 readSync             │
  │◄────────── data 帧 + seq ───────────────┤  (O_NONBLOCK, 6 ms)        │
  │                                         │◄───────────────────────────┤
```

两个技术约束决定了这个形状：

1. **Node 没有 termios 绑定。** 线路参数（波特率 / 位宽 / 校验 / 流控）全部交给系统的 `stty(1)`。
   termios 是 tty 设备自身状态，`stty` 进程退出后依然生效。
2. **tty 的 fd 不能交给 `net.Socket`**（Node 抛 `Unsupported fd type: TTY`），而阻塞读会长期占用
   libuv 线程池。因此数据面用 `O_NONBLOCK` 打开的设备 fd + 6 ms 间隔的 drain 循环，读写都不阻塞事件循环。

**下行为什么用 SSE 而不是 WebSocket：** 零第三方依赖，且 `EventSource` 自带重连语义 ——
配合环形缓冲的字节序号，断线重连后客户端按 `seq` 裁掉重叠部分即可无缝续上。服务端每 15 s 发一次心跳，
防止中间代理掐掉长连接。

---

## HTTP 接口

所有路由均在 `/api/dsh-serial` 前缀下，且只接受同源请求。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/ports` | 端口列表 + 默认波特率 + 活动会话 |
| `POST` | `/probe` | 测试连接：`{ path, baud?, timeoutMs? }` → `{ ok, verdict, received, readableRatio, sample }` |
| `POST` | `/open` | 打开会话：`{ path, baud?, dataBits?, parity?, stopBits?, flow? }` |
| `POST` | `/set` | 改线路参数：`{ session, baud?, dataBits?, parity?, stopBits?, flow? }` |
| `POST` | `/write` | 写字节：`{ session, data }`，`data` 为 base64，单次上限 64 KB |
| `POST` | `/close` | 关闭会话：`{ session }` |
| `GET` | `/stream?session=&from=` | SSE 下行，`data` 帧带累计字节序号，便于去重续传 |
| `GET` | `/assets/{xterm.js,xterm.css,addon-fit.js,XTERM-LICENSE}` | 静态资源（逐文件 exact 路由，非前缀匹配） |

---

## 安全模型

- **同源校验。** 所有路由校验 `Origin` 与 `Sec-Fetch-Site`，拒绝跨站页面驱动本机串口。
- **不做 loopback 限制。** DSH 常见部署是 dsh 监听 `127.0.0.1`、由同机 token 代理对外提供页面
  （此时 `remoteAddress` 是代理地址）。⚠️ 该代理把任何可达客户端都视为 owner，
  因此**能打开 DSH 页面的人就能操作串口设备** —— 不要把 GUI 暴露给不可信网络。
- **路径白名单。** 设备路径只放行 `/dev/` 下的简单设备名。
- **写入上限。** 单次写入 ≤ 64 KB，避免误粘贴整个文件打爆串口。
- **不碰 DTR。** 默认 `-hupcl`，见[线路参数](#线路参数)。

---

## 开发

改动 Host 半区（`lib/index.js`、`lib/engine.js`）后需要重载该条目才生效：

```text
plugin_manager set_plugin  target=include:dsh-serial  enabled=false
plugin_manager set_plugin  target=include:dsh-serial  enabled=true
```

浏览器半区（`lib/client.js`）由 clientModules 侦测重建，刷新页面即可。

---

## 已知限制

- 只支持本机串口；网络串口（`ser2net` / RFC2217）未实现。
- 无硬件调制解调器线状态显示（DCD / DSR / CTS 实时电平未采集）。
- 未注册 Agent 工具（如 `serial_exec`），当前只能由人在 GUI 里操作。
- 单设备同时只允许一个会话，第二次打开同一设备会被拒绝。

---

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `lib/engine.js` | 串口引擎：端口枚举、`stty` 参数、非阻塞 fd 读写、环形回放缓冲、会话管理 |
| `lib/index.js` | Host 半区：HTTP / SSE 路由、同源校验、静态资源下发 |
| `lib/client.js` | 浏览器半区：手写 `__ModuleLoader__` 包（无需打包器），侧边栏入口 + 主面板 |
| `lib/assets/` | 随包分发的 xterm.js / addon-fit / xterm.css |

---

## 许可

本项目以 MIT 许可发布，全文见 [LICENSE](LICENSE)。

- `lib/assets/` 下的 xterm.js、addon-fit 与样式表来自 xterm.js 项目，按其 MIT 许可分发，全文见 `lib/assets/XTERM-LICENSE`。
