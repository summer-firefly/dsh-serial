# dsh-serial · DeepSeek Harness 串口终端插件

在 DSH Web GUI 里像 minicom / SecureCRT / PuTTY 一样连接本机串口设备（USB 转串口、板载 UART），
直接在主面板里收发 Linux 命令。侧边栏出现「串口」入口，面板内是一个基于 **xterm.js** 的真实终端。

```
侧边栏「串口」 → 左侧设置栏选端口/波特率 → 连接（或先「测试连接」探一下） → 右侧终端直接敲命令
```

界面为左右分栏：**左侧固定设置栏**（线路参数、连接/测试、快捷按键、显示选项、收发计数），
**右侧终端主区**（标签栏 + xterm 画面 + 快捷发送行）。窄屏（< 820px）自动改为上下堆叠。

## 能力

| 能力 | 说明 |
| --- | --- |
| 端口枚举 | 扫描 `/dev/ttyUSB*`、`/dev/ttyACM*`、`/dev/ttyS*`、`/dev/rfcomm*`，从 sysfs 读驱动名与 USB `vid:pid`，USB 设备排在最前，实时标记「占用中」 |
| 测试连接 | 不建正式会话：临时打开端口、发一个回车、观察 1.5 s 内的回读，并用**可读字符占比**区分三种情况 —— 线路正常（`active`，可读占比 ≥ 0.85）/ 收到乱码（`garbled`，波特率或校验位不对）/ 完全没有数据（`silent`）。测试完立刻关掉端口，不影响已连接的会话 |
| 线路参数 | 波特率 9600–3000000（**默认 921600**）、数据位 5–8（默认 8）、校验 无/奇/偶（默认无）、停止位 1/2（默认 1）、流控 无/RTS-CTS/XON-XOFF（默认无）；已连接时可「应用参数」热切换 |
| 交互终端 | xterm.js 渲染（ANSI 颜色、光标、滚动回放），键盘输入直通串口，支持 `Ctrl-C`、Tab 补全、粘贴 |
| 字体 | **整个插件（设置栏、按钮、终端）统一使用字体目录里的主字体**，默认即 Monaco；主字体缺失的制表符/块元素/CJK 由第二款字体（Source Code Pro）逐字回退；再退本机 Monaco 与系统中文字体。顶栏标注当前实际使用的字体 |
| 会话保活 | 串口会话在 **Host 进程**里，切到对话再切回来、刷新页面都不会断线；重挂载时按环形缓冲（512 KB）重放，按字节序号去重，不会重复上屏 |
| 快捷发送 | 底部命令输入行，输入后回车即发（等价于键入并回车），适合粘贴长命令 |
| 快捷按键 | `Ctrl-C` / `Ctrl-D` / `Ctrl-Z` / `Tab` / `Esc` / `回车` 六个按钮，一键发送控制序列 |
| 终端外观 | 字号 10–28 px、光标样式**方块 / 下划线 / 竖线**、光标闪烁开关与**闪烁频率** 0.5–4 Hz；改动即时生效并记在 `localStorage`（`dsh-serial:prefs`），刷新后保持 |
| 收发计数 | 设置栏底部实时显示累计收/发字节数 |
| 本地回显 | 对端不回声时（例如板子没跑 getty）可勾选，把按键显示在本地 |

## 架构

```
浏览器 (xterm.js)                 Host 进程 (Node)                   串口设备
  │  POST /api/dsh-serial/write          │                                 │
  ├─────────── base64 字节 ─────────────►│  writeSync(fd) ────────────────►│
  │                                      │                                 │
  │  GET /api/dsh-serial/stream (SSE)    │  轮询 readSync (O_NONBLOCK, 6ms)│
  │◄────────── data 帧 + seq ────────────┤◄────────────────────────────────┤
```

两个技术约束决定了这个形状：

1. **Node 没有 termios 绑定。** 线路参数（波特率/位宽/校验/流控）全部交给系统的 `stty(1)` 设置；
   termios 是 tty 设备自身状态，`stty` 进程退出后依然生效。
2. **tty 的 fd 不能交给 `net.Socket`**（Node 抛 `Unsupported fd type: TTY`），而阻塞读会长期占用
   libuv 线程池。因此数据面用 `O_NONBLOCK` 打开的设备 fd + 6 ms 间隔的 drain 循环，读写都不阻塞事件循环。

下行选择 **SSE 而不是 WebSocket**：零第三方依赖，且 EventSource 自带重连语义 —— 配合环形缓冲的字节序号，
断线重连后客户端按 `seq` 裁掉重叠部分即可无缝续上。

## 安全模型

- 所有路由只接受**同源**请求（校验 `Origin` 与 `Sec-Fetch-Site`），拒绝跨站页面驱动本机串口。
- 不做 loopback 限制，因为 DSH 常见部署是 dsh 监听 `127.0.0.1`、由同机 token 代理对外提供页面
  （此时 `remoteAddress` 是代理地址）。**注意**：该代理把任何可达客户端都视为 owner，
  因此能打开 DSH 页面的人就能操作串口设备 —— 不要把 GUI 暴露给不可信网络。
- 设备路径只放行 `/dev/` 下的简单设备名，单次写入上限 64 KB，避免误粘贴整文件打爆串口。
- 打开串口默认 **不拉低 DTR**（`stty -hupcl`）。很多开发板的 DTR 接了自动复位电路，
  保持电平可以在关闭/重开串口时避免意外复位板子。

## 终端外观

三项外观偏好都放在左侧「终端」分组，改动立刻作用到 xterm，并写入 `localStorage` 的 `dsh-serial:prefs`（非法值读取时一律回退默认）。

| 选项 | 范围 | 实现 |
| --- | --- | --- |
| 字号 | 10–28 px | `term.options.fontSize` + `fit()`（字号变化会改变字符网格，必须重算行列） |
| 光标样式 | 方块 / 下划线 / 竖线 | `term.options.cursorStyle` = `block` / `underline` / `bar` |
| 闪烁 | 开 / 关 | `term.options.cursorBlink` |
| 闪烁频率 | 0.5–4 Hz（周期 2000–250 ms） | **xterm 没有这个 API** —— 它把光标动画写死成 `animation: blink_* 1s step-end infinite`。这里用更高优先级的 CSS 覆盖 `animation-duration: var(--dsr-blink, 1s) !important`，变量由运行时按频率算成毫秒写入根元素 |

改完调用 `term.refresh(0, rows - 1)` 强制重绘：光标样式与闪烁开关不是每次赋值都会立刻触发重绘，不刷一屏的话要等到下一次闪烁才看得见变化。

## 终端字体

字体分「主字体 + 字形回退」两层，**UI 与终端共用同一份字体栈**（运行时写入 `--dsr-font`，子元素全部 `font-family: inherit`）。

字体查两个目录，**用户目录优先**：

1. `<DSH_HOME>/dsh-serial/fonts/`（默认 `/var/lib/deepseek-harness/dsh-serial/fonts/`）—— 用户投放 + 下载缓存
2. `<插件目录>/lib/assets/fonts/` —— **随包自带**，解压即可用

所以：安装后无需任何配置、也不依赖联网；若之后把新字体放进用户目录，会覆盖包内自带的。

字体选择规则：

| 角色 | 选择规则 | 当前 |
| --- | --- | --- |
| 主字体 | 文件名含 `monaco` 的优先，否则取第一个字体文件 | `Monaco.ttf` |
| 字形回退 | 与主字体不同的另一个字体文件 | `SourceCodePro-Regular.ttf` |

**为什么必须两层**：Monaco 只有 358 个字形 ——

```
ASCII 0x20-0x7E   95/95   ✔ 完整
Latin-1 0xA0-0xFF 96/96   ✔ 完整
制表符 U+2500-257F  0/128  ✘ 终端画表格/进度条会掉字
块元素 U+2580-259F  0/32    ✘
箭头   U+2190-21FF  0/112  ✘
CJK    U+4E00-9FFF  0/20992 ✘ 中文输出会掉字
```

所以 ASCII 走 Monaco，缺失字形逐字落到 Source Code Pro（制表符 128/128、块元素 32/32），中文再落到系统中文字体（PingFang SC / 微软雅黑 / Noto Sans CJK）。

浏览器侧注册两个 `@font-face`：`DshSerialMono`（`/api/dsh-serial/font`）与 `DshSerialMonoFallback`（`/api/dsh-serial/font/fallback`），字体栈为：

```
"DshSerialMono", "DshSerialMonoFallback", "Monaco",
var(--ds-font-family-code, ui-monospace), Menlo, Consolas, monospace,
"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif
```

字体必须在 `Terminal.open()` 之前就绪：xterm 靠实测字符宽度计算网格，字体晚到会算错列宽，因此前端先 `await` 两个 `document.fonts.load()` 再建终端。

### 换字体

- 想用别的字体：把文件放进字体目录，文件名含 `monaco` 的会被当作主字体。
- 主字体缺失时，Host 会按 `Source Code Pro → Fira Mono → JetBrains Mono`（均为 SIL OFL）自动下载；`DSH_SERIAL_FONT_URL=<直链>` 可指定自定义下载地址。

> 本包已自带 `Monaco.ttf` 与 `SourceCodePro-Regular.ttf`，解压即可用；也可把别的字体放进字体目录替换。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-serial/ports` | 端口列表 + 默认波特率 + 活动会话 |
| POST | `/api/dsh-serial/probe` | 测试连接：`{ path, baud?, timeoutMs? }` → `{ ok, verdict, received, readableRatio, sample }` |
| POST | `/api/dsh-serial/open` | 打开会话：`{ path, baud?, dataBits?, parity?, stopBits?, flow? }` |
| POST | `/api/dsh-serial/write` | 写字节：`{ session, data(base64) }` |
| POST | `/api/dsh-serial/set` | 改线路参数：`{ session, ... }` |
| POST | `/api/dsh-serial/close` | 关闭会话：`{ session }` |
| GET | `/api/dsh-serial/stream?session=&from=` | SSE 下行（`data` 帧带累计字节序号，便于去重续传） |
| GET | `/api/dsh-serial/assets/{xterm.js,xterm.css,addon-fit.js,XTERM-LICENSE}` | 静态资源，逐文件 exact 路由（非前缀匹配） |
| GET | `/api/dsh-serial/font` | 下发主字体文件（不装则 404） |
| GET | `/api/dsh-serial/font/fallback` | 下发行形回退字体 |
| POST | `/api/dsh-serial/font` | 确保主字体与回退字体就位（缺则下载），返回 `{ font, fallback }` |

## 已知限制

- 只支持本机串口；网络串口（`ser2net`/RFC2217）未实现。
- 无硬件调制解调器线状态显示（DCD/DSR/CTS 的实时电平未采集）。
- 未注册 Agent 工具（`serial_exec` 之类），当前只能由人在 GUI 里操作。
- 单设备同时只允许一个会话（第二次打开同一设备会被拒绝）。

## 安装

插件以 profile bundle 形式挂载（不需要改 DSH 源码）：

```sh
# 目录就位
ln -s /root/test/dsh-serial /var/lib/deepseek-harness/profiles/web/node_modules/dsh-serial

# profile 登记（package.json）
#   dependencies: { "dsh-serial": "link:/root/test/dsh-serial" }
#   dsh.profile.bundles: [ ..., "dsh-serial" ]
```

本包自带 `cordis.patch.yml`，以 `insert` 行把自身挂进 layer 栈；`dsh.client` 声明让 Web 端加载
`./client` 作为浏览器半区。

改动 Host 半区（`lib/index.js`、`lib/engine.js`）后需要重载该条目才会生效：

```
plugin_manager set_plugin  target=include:dsh-serial  enabled=false
plugin_manager set_plugin  target=include:dsh-serial  enabled=true
```

浏览器半区（`lib/client.js`）由 clientModules 侦测重建，页面刷新即可。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/engine.js` | 串口引擎：端口枚举、stty 参数、非阻塞 fd 读写、环形回放缓冲、会话管理 |
| `lib/index.js` | Host 半区：HTTP/SSE 路由、同源校验、静态资源下发 |
| `lib/client.js` | 浏览器半区：手写 `__ModuleLoader__` 包（无需打包器），侧边栏入口 + 主面板 |
| `lib/assets/` | 随包分发的 xterm.js / addon-fit / xterm.css（MIT，见 `XTERM-LICENSE`） |

## 许可

MIT。`lib/assets/` 下的 xterm.js 与 addon-fit 为 xterm.js 项目产物，按其 MIT 许可分发。
