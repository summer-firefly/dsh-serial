/**
 * dsh-serial · 浏览器半区
 *
 * 手写的 __ModuleLoader__ 包（无需打包器）：只 require 运行时注入的 react，
 * xterm.js 与 fit 插件通过 Host 的 /api/dsh-serial/assets 路由按需加载。
 *
 * 界面：左侧固定设置栏（端口/线路参数/操作/快捷按键），右侧终端主区。
 *
 * 关键取舍：
 * - 串口会话的真相在 Host 里（SSE + 环形回放缓冲）。切面板只 detach 视图，
 *   回到串口面板时用同一个 sessionId 重新 attach，并把缓冲从 seq=0 重放，
 *   所以刷新页面/切换对话都不会打断板子上的会话。
 * - 下行帧自带累计序号，客户端按序号裁剪重叠字节，EventSource 自动重连时
 *   不会重复上屏。
 */
window.__ModuleLoader__.load({
	id: "dsh-serial",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** 面板在侧边栏里的排序（Plugins 0、Schedule 10、Context 20、SSH 40）。 */
		const PANEL_ORDER = 45;
		/** 面板 id：同时是 sidebar.panellist 的 id 与 main 插槽的 key。 */
		const PANEL_ID = "serial";
		/** Host 路由前缀。 */
		const API = "/api/dsh-serial";
		/** 默认波特率；Host 的 /ports 也会回传它，这里只是首帧兜底。 */
		const DEFAULT_BAUD = 921600;

		const BAUD_CHOICES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000, 3000000];
		const DATA_BITS_CHOICES = [5, 6, 7, 8];
		const PARITY_CHOICES = [
			["none", "无"],
			["even", "偶"],
			["odd", "奇"],
		];
		const STOP_BITS_CHOICES = [1, 2];
		const FLOW_CHOICES = [
			["none", "无"],
			["rtscts", "RTS/CTS"],
			["xonxoff", "XON/XOFF"],
		];

		/** 快捷按键：标签 → 实际发送的字节。 */
		const QUICK_KEYS = [
			["Ctrl-C", "\u0003"],
			["Ctrl-D", "\u0004"],
			["Ctrl-Z", "\u001a"],
			["Tab", "\t"],
			["Esc", "\u001b"],
			["回车", "\r"],
		];

		/**
		 * 模块级共享状态：面板卸载后仍然存活，使宿主会话可以被重新接上。
		 * 只有它，让「切到对话再切回来」不会掉线。
		 */
		const shared = {
			sessionId: null,
			path: null,
			options: null,
			renderer: null
		};

		//#region 工具函数
		/** base64 → Uint8Array。 */
		function decodeBase64(text) {
			const binary = atob(text);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
			return bytes;
		}

		/** Uint8Array → base64（分块，避免大片段爆栈）。 */
		function encodeBase64(bytes) {
			let binary = "";
			const step = 0x8000;
			for (let offset = 0; offset < bytes.length; offset += step) {
				binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + step));
			}
			return btoa(binary);
		}

		/** 请求 JSON 接口。 */
		async function postJson(path, body) {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
			return payload;
		}

		/** 字节数 → 人类可读。 */
		function formatBytes(count) {
			if (count < 1024) return `${count} B`;
			if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
			return `${(count / 1024 / 1024).toFixed(2)} MB`;
		}
		//#endregion

		//#region 终端外观偏好
		/** 外观偏好落在 localStorage，刷新后保持。 */
		const PREFS_KEY = "dsh-serial:prefs";
		const DEFAULT_PREFS = { fontSize: 13, cursorStyle: "block", cursorBlink: true, blinkHz: 1 };
		const CURSOR_STYLES = [
			["block", "方块"],
			["underline", "下划线"],
			["bar", "竖线"]
		];

		/** 夹到区间内。 */
		function clamp(value, low, high) {
			return Math.min(Math.max(value, low), high);
		}

		/** 读取外观偏好，非法值一律回退默认。 */
		function loadPrefs() {
			try {
				const raw = localStorage.getItem(PREFS_KEY);
				if (raw === null) return { ...DEFAULT_PREFS };
				const parsed = JSON.parse(raw);
				const fontSize = Number(parsed?.fontSize);
				const blinkHz = Number(parsed?.blinkHz);
				return {
					fontSize: Number.isFinite(fontSize) ? clamp(fontSize, 10, 28) : DEFAULT_PREFS.fontSize,
					cursorStyle: CURSOR_STYLES.some(([value]) => value === parsed?.cursorStyle)
						? parsed.cursorStyle
						: DEFAULT_PREFS.cursorStyle,
					cursorBlink: parsed?.cursorBlink !== false,
					blinkHz: Number.isFinite(blinkHz) ? clamp(blinkHz, 0.5, 4) : DEFAULT_PREFS.blinkHz
				};
			} catch {
				return { ...DEFAULT_PREFS };
			}
		}

		/** 写入外观偏好（失败静默：存不了也不该影响终端）。 */
		function savePrefs(prefs) {
			try {
				localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
			} catch {}
		}

		/** 页面生命周期内只读一次作为初值。 */
		const savedPrefs = loadPrefs();

		//#endregion

		//#region xterm 按需加载
		/** 已经插入过的资源，避免重复 <script>。 */
		const assetPromises = new Map();

		/** 插入一个 <script> 并等它执行完。 */
		function loadScript(src) {
			if (!assetPromises.has(src)) {
				assetPromises.set(src, new Promise((resolve, reject) => {
					const script = document.createElement("script");
					script.src = src;
					script.async = true;
					script.onload = () => resolve(undefined);
					script.onerror = () => reject(new Error(`加载失败：${src}`));
					document.head.appendChild(script);
				}));
			}
			return assetPromises.get(src);
		}

		/** 插入一个 <link rel=stylesheet>。 */
		function loadStyle(href) {
			if (!assetPromises.has(href)) {
				assetPromises.set(href, new Promise((resolve) => {
					if (document.querySelector(`link[data-dsh-serial="${href}"]`) !== null) {
						resolve(undefined);
						return;
					}
					const link = document.createElement("link");
					link.rel = "stylesheet";
					link.href = href;
					link.dataset.dshSerial = href;
					link.onload = () => resolve(undefined);
					link.onerror = () => resolve(undefined);
					document.head.appendChild(link);
				}));
			}
			return assetPromises.get(href);
		}

		/**
		 * 取到 xterm 的构造器与 fit 插件。
		 * @returns {{Terminal: Function, FitAddon: Function|undefined}}
		 */
		async function ensureXterm() {
			await loadStyle(`${API}/assets/xterm.css`);
			if (typeof window.Terminal !== "function") await loadScript(`${API}/assets/xterm.js`);
			if (window.FitAddon === undefined) await loadScript(`${API}/assets/addon-fit.js`);
			if (typeof window.Terminal !== "function") throw new Error("xterm 未加载成功");
			const fit = window.FitAddon;
			const FitAddon = fit !== undefined && typeof fit.FitAddon === "function" ? fit.FitAddon : undefined;
			return { Terminal: window.Terminal, FitAddon };
		}
		//#endregion

		//#region 字体
		/** 本机 Monaco 的名字：Host 字体加载失败时的次选。 */
		const PREFERRED_FONT = "Monaco";
		/** 中文与符号兜底：Monaco 只有 358 个字形，中文/全角标点全靠这里。 */
		const CJK_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';
		/** 最终兜底的系统等宽栈。 */
		const SYSTEM_STACK = `var(--ds-font-family-code, ui-monospace), Menlo, Consolas, monospace, ${CJK_STACK}`;

		/**
		 * 字体状态（模块级：一次页面会话只解析一次）。
		 * `stack` 是完整的 CSS font-family 值，UI 与终端共用同一份。
		 */
		const fontState = { stack: null, label: null, detail: null, status: "pending" };

		/**
		 * 判断某个字体在本机是否真的可用。
		 * 用 canvas 测宽比对：装了这个字体时同一段文字的宽度会和 monospace 不同。
		 * @param name - 字体族名。
		 * @returns 本机是否装有该字体。
		 */
		function isFontAvailable(name) {
			try {
				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d");
				if (context === null) return false;
				const probe = "mmmmmmmmmmlliWW00O0123456789";
				context.font = "72px monospace";
				const baseline = context.measureText(probe).width;
				context.font = `72px "${name}", monospace`;
				return context.measureText(probe).width !== baseline;
			} catch {
				return false;
			}
		}

		/**
		 * 让插件字体就绪。
		 *
		 * Host 侧字体是权威来源（用户把自己的 Monaco 放在了字体目录里），所以：
		 *   - 「主字体」= Host 的主字体文件（Monaco），注册为 DshSerialMono；
		 *   - 「字形回退」= Host 的第二款字体（Source Code Pro），注册为 DshSerialMonoFallback；
		 *     Monaco 缺少制表符 U+2500-257F、块元素、箭头与全部 CJK，表格/进度条/中文靠它渲染；
		 *   - 再往后是本机 Monaco、系统等宽、系统中文字体。
		 * 整个插件（设置栏、按钮、终端）统一用这一份字体栈。
		 * @returns {{stack: string|null, label: string, detail: string, status: string}}
		 */
		async function ensureFont() {
			if (fontState.status !== "pending") return fontState;
			const families = [];
			const labels = [];
			try {
				const payload = await postJson(`${API}/font`, {});
				const faces = [];
				if (payload.font != null) {
					faces.push({
						family: payload.font.alias,
						url: `${API}/font`,
						note: `${payload.font.label}（主字体，Host 下发）`,
						order: 0
					});
				}
				if (payload.fallback != null) {
					faces.push({
						family: `${payload.fallback.alias}Fallback`,
						url: `${API}/font/fallback`,
						note: `${payload.fallback.label}（字形回退）`,
						order: 1
					});
				}
				if (faces.length > 0) {
					const style = document.createElement("style");
					style.dataset.dshSerialFont = "1";
					// font-weight 写成区间：部分字体是可变字体，只写 400 会落到首实例（可能过细）。
					style.textContent = faces
						.map((face) => `@font-face{font-family:"${face.family}";src:url("${face.url}");font-weight:100 900;font-style:normal;font-display:swap;}`)
						.join("");
					document.head.appendChild(style);
					await Promise.all(faces.map((face) => document.fonts.load(`13px "${face.family}"`)));
					for (const face of faces.sort((a, b) => a.order - b.order)) {
						families.push(`"${face.family}"`);
						labels.push(face.note);
					}
				}
			} catch (fontError) {
				fontState.detail = `Host 字体不可用：${String(fontError.message ?? fontError)}`;
			}
			// 次选：本机 Monaco（Mac 自带），再退系统等宽与中文字体
			families.push(`"${PREFERRED_FONT}"`);
			families.push(SYSTEM_STACK);
			fontState.stack = families.join(", ");
			if (labels.length > 0) {
				fontState.label = labels[0].split("（")[0];
				fontState.detail = labels.join("；");
				fontState.status = "webfont";
			} else {
				fontState.label = isFontAvailable(PREFERRED_FONT) ? PREFERRED_FONT : "系统等宽";
				fontState.detail = `${fontState.detail ?? ""} 已回退到本机字体`.trim();
				fontState.status = "fallback";
			}
			return fontState;
		}

		//#endregion

		//#region 样式
		const CSS = `
.dsr-root {
	display: flex;
	height: 100%;
	min-height: 360px;
	background: var(--dsw-alias-bg-base, #0f1115);
	color: var(--dsw-alias-label-primary, #e6e6e6);
	/* 整个插件的字体由运行时写入 --dsr-font（Monaco + 字形回退 + 中文兜底），
	   子元素一律 font-family: inherit，保证设置栏、按钮、终端用同一套字体。 */
	font-family: var(--dsr-font, var(--ds-font-family-code, ui-monospace), Menlo, Consolas, monospace);
	font-size: 13px;
}

/* ---------- 左侧设置栏 ---------- */
.dsr-side {
	display: flex;
	flex-direction: column;
	gap: 18px;
	flex: 0 0 264px;
	width: 264px;
	padding: 16px 14px;
	overflow-y: auto;
	background: var(--dsw-alias-bg-layer-1, #14161c);
	border-right: 1px solid var(--dsw-alias-border-l1, #262a33);
}
.dsr-side::-webkit-scrollbar { width: 6px; }
.dsr-side::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2, #333a45); border-radius: 3px; }

.dsr-brand { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsr-brand-title { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.dsr-brand-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, #8b94a3); margin-top: 2px; }

.dsr-pill {
	display: inline-flex; align-items: center; gap: 6px;
	padding: 3px 9px; border-radius: 999px;
	font-size: 11px; line-height: 1.4;
	border: 1px solid var(--dsw-alias-border-l1, #262a33);
	background: var(--dsw-alias-bg-layer-2, #1b1f27);
	color: var(--dsw-alias-label-secondary, #8b94a3);
	white-space: nowrap;
}
.dsr-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .7; }
/* 状态色只用于圆点与描边，文字统一用 label-primary：
   浅色主题下状态绿 #22c55e / 警告黄 #f59e0b 落在白底上只有 2.2:1，用作正文会看不清。 */
.dsr-pill.on {
	color: var(--dsw-alias-label-primary, #e6e6e6);
	border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #40c057) 45%, transparent);
}
.dsr-pill.on .dsr-pill-dot {
	background: var(--dsw-alias-state-success-primary, #40c057);
	opacity: 1;
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #40c057) 22%, transparent);
}
.dsr-pill.err {
	color: var(--dsw-alias-label-primary, #e6e6e6);
	border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 45%, transparent);
}
.dsr-pill.err .dsr-pill-dot { background: var(--dsw-alias-state-error-primary, #ff6b6b); opacity: 1; }
.dsr-pill.busy {
	color: var(--dsw-alias-label-primary, #e6e6e6);
	border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 45%, transparent);
}
.dsr-pill.busy .dsr-pill-dot { background: var(--dsw-alias-state-warn-primary, #f59e0b); opacity: 1; animation: dsr-pulse 1s ease-in-out infinite; }
@keyframes dsr-pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

.dsr-group { display: flex; flex-direction: column; gap: 10px; }
.dsr-group-head {
	font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
	color: var(--dsw-alias-label-secondary, #8b94a3);
}
.dsr-fields { display: flex; flex-direction: column; gap: 10px; }
.dsr-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

.dsr-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsr-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #8b94a3); }
.dsr-control { position: relative; display: flex; }
.dsr-control select {
	flex: 1 1 auto; min-width: 0; width: 100%;
	appearance: none; -webkit-appearance: none;
	height: 32px; padding: 0 26px 0 9px;
	border-radius: 8px;
	border: 1px solid var(--dsw-alias-border-l1, #262a33);
	background: var(--dsw-alias-bg-layer-2, #1b1f27);
	color: var(--dsw-alias-label-primary, #e6e6e6);
	font-family: inherit; font-size: 12px;
	transition: border-color .15s, box-shadow .15s;
}
.dsr-control select:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2, #3a4250); }
.dsr-control select:focus-visible {
	outline: none;
	border-color: var(--dsw-alias-brand-primary, #6c8cff);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #6c8cff) 20%, transparent);
}
.dsr-control select:disabled { opacity: .5; cursor: not-allowed; }
/* 原生下拉的弹出层在某些平台上不继承 select 的配色，显式给 option 上色，避免白底白字 */
.dsr-control select option {
	background: var(--dsw-alias-bg-layer-2, #1b1f27);
	color: var(--dsw-alias-label-primary, #e6e6e6);
}
.dsr-control::after {
	content: ""; position: absolute; right: 11px; top: 13px;
	width: 5px; height: 5px;
	border-right: 1.5px solid var(--dsw-alias-label-secondary, #8b94a3);
	border-bottom: 1.5px solid var(--dsw-alias-label-secondary, #8b94a3);
	transform: rotate(45deg); pointer-events: none;
}
.dsr-hint {
	font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8b94a3);
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.dsr-btn {
	display: inline-flex; align-items: center; justify-content: center; gap: 6px;
	height: 32px; padding: 0 12px;
	border-radius: 8px; cursor: pointer;
	border: 1px solid var(--dsw-alias-border-l1, #262a33);
	background: var(--dsw-alias-bg-layer-2, #1b1f27);
	color: var(--dsw-alias-label-primary, #e6e6e6);
	font-family: inherit; font-size: 12px; font-weight: 500;
	transition: border-color .15s, background .15s, opacity .15s, transform .06s;
	white-space: nowrap;
}
.dsr-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2, #3a4250); background: var(--dsw-alias-bg-layer-1, #14161c); }
.dsr-btn:active:not(:disabled) { transform: translateY(1px); }
.dsr-btn:disabled { opacity: .45; cursor: not-allowed; }
/* 主按钮：brand-primary 在浅色主题是近黑(#0f1115)、深色主题是近白(#f9fafb)，
   所以文字必须用它的反色 bg-base，绝不能写死 #fff —— 否则深色主题下就是白底白字。 */
.dsr-btn-primary {
	border-color: transparent;
	background: var(--dsw-alias-brand-primary, #4c6ef5);
	color: var(--dsw-alias-bg-base, #0f1115);
	font-weight: 600;
}
.dsr-btn-primary:hover:not(:disabled) {
	background: var(--dsw-alias-brand-primary, #4c6ef5);
	/* 近白填充上 brightness 提亮没有效果，改用透明度做 hover 反馈，两种主题都可见 */
	opacity: .86;
}
/* 状态红直接当文字色时，深色主题下是 4.24:1（略低于 AA），朝 label-primary 混一点即可两种主题都达标 */
.dsr-btn-danger {
	color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 72%, var(--dsw-alias-label-primary, #e6e6e6));
	border-color: color-mix(in srgb, currentColor 30%, transparent);
	background: transparent;
}
.dsr-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, currentColor 10%, transparent); border-color: currentColor; }
.dsr-btn-block { width: 100%; }
.dsr-btn-row { display: flex; gap: 8px; }
.dsr-btn-row > .dsr-btn { flex: 1 1 0; }

/* 快捷按键 */
.dsr-keys { display: flex; flex-wrap: wrap; gap: 6px; }
.dsr-kbd {
	padding: 4px 9px; border-radius: 6px; cursor: pointer;
	border: 1px solid var(--dsw-alias-border-l1, #262a33);
	background: var(--dsw-alias-bg-layer-2, #1b1f27);
	color: var(--dsw-alias-label-secondary, #8b94a3);
	font-family: inherit; font-size: 11px;
	transition: color .15s, border-color .15s;
}
.dsr-kbd:hover:not(:disabled) { color: var(--dsw-alias-brand-primary, #6c8cff); border-color: currentColor; }
.dsr-kbd:disabled { opacity: .4; cursor: not-allowed; }

/* 开关 */
.dsr-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dsr-switch-text { font-size: 12px; }
.dsr-switch-desc { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8b94a3); margin-top: 2px; }
.dsr-switch { position: relative; display: inline-flex; flex: 0 0 auto; }
.dsr-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.dsr-switch-track {
	width: 34px; height: 19px; border-radius: 999px;
	background: var(--dsw-alias-border-l2, #3a4250);
	transition: background .18s;
	position: relative;
}
.dsr-switch-track::after {
	content: ""; position: absolute; top: 2px; left: 2px;
	width: 15px; height: 15px; border-radius: 50%;
	/* 滑块同样跟随反色：浅色主题品牌色近黑→滑块白，深色主题品牌色近白→滑块深 */
	background: var(--dsw-alias-bg-base, #0f1115); transition: transform .18s;
}
.dsr-switch input:checked + .dsr-switch-track { background: var(--dsw-alias-brand-primary, #6c8cff); }
.dsr-switch input:checked + .dsr-switch-track::after { transform: translateX(15px); }
.dsr-switch input:focus-visible + .dsr-switch-track { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #6c8cff) 25%, transparent); }

/* 测试结果卡片 */
.dsr-probe {
	border-radius: 10px; padding: 10px 11px;
	border: 1px solid var(--dsw-alias-border-l1, #262a33);
	background: var(--dsw-alias-bg-layer-2, #1b1f27);
	font-size: 11.5px; line-height: 1.6;
}
.dsr-probe.ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #40c057) 45%, transparent); }
.dsr-probe.warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f2b53b) 45%, transparent); }
.dsr-probe.bad { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 45%, transparent); }
.dsr-probe-title { font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
/* 标题文字同样走 label-primary，状态只体现在前置圆点上（对比度原因同上）。 */
.dsr-probe-title::before {
	content: ""; flex: 0 0 auto;
	width: 6px; height: 6px; border-radius: 50%;
	background: var(--dsw-alias-label-secondary, #8b94a3);
}
.dsr-probe.ok .dsr-probe-title::before { background: var(--dsw-alias-state-success-primary, #40c057); }
.dsr-probe.warn .dsr-probe-title::before { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsr-probe.bad .dsr-probe-title::before { background: var(--dsw-alias-state-error-primary, #ff6b6b); }
.dsr-probe-body { color: var(--dsw-alias-label-secondary, #8b94a3); }
.dsr-probe-sample {
	margin-top: 7px; padding: 6px 8px; border-radius: 6px;
	background: var(--dsw-alias-bg-base, #0f1115);
	color: var(--dsw-alias-label-secondary, #8b94a3);
	font-size: 10.5px; line-height: 1.45;
	white-space: pre-wrap; word-break: break-all;
	max-height: 72px; overflow: hidden;
}

.dsr-meta {
	display: flex; justify-content: space-between; gap: 8px;
	font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8b94a3);
	padding-top: 2px; border-top: 1px solid var(--dsw-alias-border-l1, #262a33);
}
.dsr-meta b { font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }

/* ---------- 右侧主区 ---------- */
.dsr-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.dsr-topbar {
	display: flex; align-items: center; gap: 10px;
	padding: 10px 14px;
	border-bottom: 1px solid var(--dsw-alias-border-l1, #262a33);
	font-size: 11.5px;
	color: var(--dsw-alias-label-secondary, #8b94a3);
}
.dsr-topbar-path { font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }
.dsr-topbar-sep { opacity: .45; }
.dsr-topbar-spacer { flex: 1 1 auto; }

.dsr-screen-wrap {
	flex: 1 1 auto; min-height: 0;
	margin: 10px 12px 0;
	border-radius: 12px;
	border: 1px solid var(--dsw-alias-border-l1, #262a33);
	background: #0b0e14;
	overflow: hidden;
	position: relative;
}
.dsr-screen { position: absolute; inset: 0; padding: 8px 4px 4px 10px; }
.dsr-screen .xterm { height: 100%; }
.dsr-screen .xterm-viewport { background: transparent !important; }
.dsr-idle {
	position: absolute; inset: 0;
	display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
	color: var(--dsw-alias-label-secondary, #8b94a3);
	font-size: 12px; line-height: 1.7; text-align: center;
	padding: 20px;
}
.dsr-idle-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }

.dsr-send { display: flex; gap: 8px; padding: 10px 12px 12px; }
.dsr-send input {
	flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 10px;
	border-radius: 8px;
	border: 1px solid var(--dsw-alias-border-l1, #262a33);
	background: var(--dsw-alias-bg-layer-1, #14161c);
	color: var(--dsw-alias-label-primary, #e6e6e6);
	font-family: inherit; font-size: 12px;
	transition: border-color .15s, box-shadow .15s;
}
.dsr-send input:focus-visible {
	outline: none;
	border-color: var(--dsw-alias-brand-primary, #6c8cff);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #6c8cff) 20%, transparent);
}
.dsr-send input::placeholder { color: var(--dsw-alias-label-secondary, #8b94a3); opacity: .8; }

.dsr-error {
	margin: 10px 12px 0; padding: 8px 11px; border-radius: 8px;
	font-size: 11.5px; line-height: 1.6;
	color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff6b6b) 72%, var(--dsw-alias-label-primary, #e6e6e6));
	border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
	background: color-mix(in srgb, currentColor 8%, transparent);
}

/* 行内标签 + 当前值（滑块类控件用） */
.dsr-label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dsr-value {
	font-size: 10.5px; font-variant-numeric: tabular-nums;
	color: var(--dsw-alias-label-primary, #e6e6e6); opacity: .85;
}

/* 滑块 */
.dsr-range {
	appearance: none; -webkit-appearance: none;
	width: 100%; height: 4px; border-radius: 999px;
	background: var(--dsw-alias-border-l2, #3a4250);
	outline: none; cursor: pointer; margin: 4px 0 2px;
}
.dsr-range::-webkit-slider-thumb {
	appearance: none; -webkit-appearance: none;
	width: 13px; height: 13px; border-radius: 50%;
	background: var(--dsw-alias-brand-primary, #4c6ef5);
	border: 2px solid var(--dsw-alias-bg-layer-1, #14161c);
	cursor: pointer;
}
.dsr-range::-moz-range-thumb {
	width: 13px; height: 13px; border-radius: 50%;
	background: var(--dsw-alias-brand-primary, #4c6ef5);
	border: 2px solid var(--dsw-alias-bg-layer-1, #14161c);
	cursor: pointer;
}
.dsr-range:focus-visible { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4c6ef5) 25%, transparent); }

/* 分段控件（光标样式） */
.dsr-seg {
	display: flex; border-radius: 8px; overflow: hidden;
	border: 1px solid var(--dsw-alias-border-l1, #262a33);
}
.dsr-seg button {
	flex: 1 1 0; padding: 6px 0; cursor: pointer;
	border: none; background: transparent;
	color: var(--dsw-alias-label-secondary, #8b94a3);
	font-family: inherit; font-size: 11.5px;
	transition: background .15s, color .15s;
}
.dsr-seg button + button { border-left: 1px solid var(--dsw-alias-border-l1, #262a33); }
.dsr-seg button:hover:not(.on) { color: var(--dsw-alias-label-primary, #e6e6e6); }
.dsr-seg button.on {
	background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4c6ef5) 16%, transparent);
	color: var(--dsw-alias-label-primary, #e6e6e6);
	font-weight: 600;
}

/* 光标闪烁周期：xterm 把动画时长写死为 1s，且没有对应 API，
   只能靠更高优先级覆盖 animation-duration。--dsr-blink 由运行时写入。 */
.dsr-screen .xterm .xterm-cursor.xterm-cursor-blink.xterm-cursor-block,
.dsr-screen .xterm .xterm-cursor.xterm-cursor-blink.xterm-cursor-underline,
.dsr-screen .xterm .xterm-cursor.xterm-cursor-blink.xterm-cursor-bar {
	animation-duration: var(--dsr-blink, 1s) !important;
}

@media (max-width: 820px) {
	.dsr-root { flex-direction: column; }
	.dsr-side { flex: 0 0 auto; width: auto; border-right: none; border-bottom: 1px solid var(--dsw-alias-border-l1, #262a33); }
}
`;

		/** 端口一行摘要。 */
		function portSummary(port) {
			const parts = [port.path];
			if (port.driver !== undefined) parts.push(port.driver);
			if (port.vid !== undefined && port.pid !== undefined) parts.push(`${port.vid}:${port.pid}`);
			if (port.inUse === true) parts.push("占用中");
			return parts.join(" · ");
		}

		/** 一个下拉字段。 */
		function Field({ label, value, onChange, choices, disabled, hint }) {
			return h("div", { className: "dsr-field" },
				h("span", { className: "dsr-label" }, label),
				h("div", { className: "dsr-control" },
					h("select", {
						value,
						disabled,
						onChange: (event) => onChange(event.target.value)
					}, choices.map(([optionValue, optionLabel]) =>
						h("option", { key: optionValue, value: optionValue }, optionLabel)))),
				hint !== undefined && hint !== "" ? h("span", { className: "dsr-hint", title: hint }, hint) : null);
		}

		//#region 主页面组件
		/**
		 * 串口面板页：左侧设置栏 + 右侧 xterm 终端。
		 * @returns 面板 React 元素。
		 */
		function SerialPage() {
			const [ports, setPorts] = React.useState([]);
			const [path, setPath] = React.useState(shared.path ?? "/dev/ttyUSB0");
			const [baud, setBaud] = React.useState(shared.options?.baud ?? DEFAULT_BAUD);
			const [dataBits, setDataBits] = React.useState(shared.options?.dataBits ?? 8);
			const [parity, setParity] = React.useState(shared.options?.parity ?? "none");
			const [stopBits, setStopBits] = React.useState(shared.options?.stopBits ?? 1);
			const [flow, setFlow] = React.useState(shared.options?.flow ?? "none");
			const [localEcho, setLocalEcho] = React.useState(false);
			const [connected, setConnected] = React.useState(shared.sessionId !== null);
			const [busy, setBusy] = React.useState(false);
			const [testing, setTesting] = React.useState(false);
			const [probe, setProbe] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [command, setCommand] = React.useState("");
			const [renderer, setRenderer] = React.useState("pending");
			const [stats, setStats] = React.useState({ rx: 0, tx: 0 });
			/** 设备被占用时展示的接管提示。 */
			const [conflict, setConflict] = React.useState(null);
			const [fontSize, setFontSize] = React.useState(savedPrefs.fontSize);
			const [cursorStyle, setCursorStyle] = React.useState(savedPrefs.cursorStyle);
			const [cursorBlink, setCursorBlink] = React.useState(savedPrefs.cursorBlink);
			const [blinkHz, setBlinkHz] = React.useState(savedPrefs.blinkHz);
			/** 终端实际使用的字体信息（用于在顶栏标注）。 */
			const [fontInfo, setFontInfo] = React.useState(fontState.status === "pending" ? null : { ...fontState });
			/** 当前选中的端口，供轮询回调读取最新值。 */
			const pathRef = React.useRef(path);
			pathRef.current = path;

			const screenRef = React.useRef(null);
			const termRef = React.useRef(null);
			const fitRef = React.useRef(null);
			const streamRef = React.useRef(null);
			const sessionRef = React.useRef(shared.sessionId);
			const receivedRef = React.useRef(0);
			const rxRef = React.useRef(0);
			const txRef = React.useRef(0);
			const echoRef = React.useRef(localEcho);

			echoRef.current = localEcho;

			/** 让终端铺满容器。 */
			const refit = React.useCallback(() => {
				const fit = fitRef.current;
				if (fit === null) return;
				try {
					fit.fit();
				} catch {}
			}, []);

			/**
			 * 把外观偏好应用到已打开的终端，并落盘。
			 * 字号变化会改变字符网格，改完必须重新 fit，否则列数/行数会算错。
			 */
			React.useEffect(() => {
				savePrefs({ fontSize, cursorStyle, cursorBlink, blinkHz });
				const term = termRef.current;
				if (term === null) return;
				try {
					term.options.fontSize = fontSize;
					term.options.cursorStyle = cursorStyle;
					term.options.cursorBlink = cursorBlink;
					// 光标样式/闪烁不是每次改都会立刻触发重绘，主动刷一屏让它即时生效。
					term.refresh(0, Math.max(0, term.rows - 1));
				} catch {}
				refit();
				requestAnimationFrame(() => refit());
			}, [fontSize, cursorStyle, cursorBlink, blinkHz, renderer, refit]);

			/** 收发字节计数（500ms 汇总一次，避免每帧都重渲染）。 */
			React.useEffect(() => {
				const timer = setInterval(() => {
					setStats({ rx: rxRef.current, tx: txRef.current });
				}, 500);
				return () => clearInterval(timer);
			}, []);

			/** 建 xterm 实例（只在挂载时一次）。 */
			React.useEffect(() => {
				let disposed = false;
				let observer;
				let term;
				(async () => {
					try {
						const loaded = await ensureXterm();
						if (disposed || screenRef.current === null) return;
						// 字体必须在 open() 之前就绪：xterm 靠实测字符宽度算网格，字体晚到会算错列宽。
						const font = await ensureFont();
						if (!disposed) setFontInfo({ ...font });
						if (disposed || screenRef.current === null) return;
						const fontFamily = font.stack ?? SYSTEM_STACK;
						term = new loaded.Terminal({
							cursorBlink: savedPrefs.cursorBlink,
							cursorStyle: savedPrefs.cursorStyle,
							fontSize: savedPrefs.fontSize,
							lineHeight: 1.2,
							scrollback: 8000,
							convertEol: false,
							fontFamily,
							theme: {
								background: "#0b0e14",
								foreground: "#d8dee9",
								cursor: "#d8dee9",
								selectionBackground: "#3b4252"
							}
						});
						term.open(screenRef.current);
						termRef.current = term;
						shared.renderer = term;
						if (loaded.FitAddon !== undefined) {
							const fit = new loaded.FitAddon();
							term.loadAddon(fit);
							fitRef.current = fit;
						}
						setRenderer("ready");
						refit();
						requestAnimationFrame(() => refit());
						setTimeout(() => refit(), 120);
						observer = new ResizeObserver(() => refit());
						observer.observe(screenRef.current);
						term.onData((data) => sendBytes(new TextEncoder().encode(data), true));
						if (shared.sessionId !== null) attach(shared.sessionId);
					} catch (loadError) {
						if (!disposed) {
							setRenderer("failed");
							setError(String(loadError.message ?? loadError));
						}
					}
				})();
				return () => {
					disposed = true;
					if (observer !== undefined) observer.disconnect();
					detach();
					if (term !== undefined) term.dispose();
					termRef.current = null;
					fitRef.current = null;
					shared.renderer = null;
				};
			}, []);

			/** 刷新串口列表。 */
			const refreshPorts = React.useCallback(async () => {
				try {
					const response = await fetch(`${API}/ports`);
					const payload = await response.json();
					if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
					setPorts(payload.ports ?? []);
					if (typeof payload.defaultBaud === "number" && shared.sessionId === null && shared.options === null) {
						setBaud(payload.defaultBaud);
					}
					const usb = (payload.ports ?? []).find((candidate) => candidate.bus === "usb");
					if (usb !== undefined) setPath((current) => (current === "" ? usb.path : current));
					// 接管：Host 已经有一个活动会话时（页面刷新、切换面板后回来、另一个标签页开的），
					// 直接接上去，而不是显示「未连接」然后在点连接时撞「已被占用」。
					const sessions = payload.sessions ?? [];
					if (sessionRef.current === null && sessions.length > 0) {
						const preferred = sessions.find((candidate) => candidate.path === pathRef.current) ?? sessions[0];
						shared.sessionId = preferred.sessionId;
						shared.path = preferred.path;
						shared.options = preferred.options;
						sessionRef.current = preferred.sessionId;
						setPath(preferred.path);
						if (preferred.options !== undefined) {
							setBaud(preferred.options.baud);
							setDataBits(preferred.options.dataBits);
							setParity(preferred.options.parity);
							setStopBits(preferred.options.stopBits);
							setFlow(preferred.options.flow);
						}
						if (termRef.current !== null) {
							termRef.current.reset();
							termRef.current.write("\u001b[2m── 已接上既有会话（Host 侧保活）──\u001b[0m\r\n");
						}
						setConnected(true);
						attach(preferred.sessionId);
					}
				} catch (refreshError) {
					setError(String(refreshError.message ?? refreshError));
				}
			}, []);

			React.useEffect(() => {
				refreshPorts();
				const timer = setInterval(refreshPorts, 10000);
				return () => clearInterval(timer);
			}, [refreshPorts]);

			/** 关闭下行连接（不动 Host 会话）。 */
			function detach() {
				const stream = streamRef.current;
				if (stream !== null) {
					stream.close();
					streamRef.current = null;
				}
			}

			/**
			 * 接上 Host 会话的下行流。
			 * @param sessionId - Host 会话 id。
			 */
			function attach(sessionId) {
				detach();
				receivedRef.current = 0;
				const stream = new EventSource(`${API}/stream?session=${encodeURIComponent(sessionId)}&from=0`);
				streamRef.current = stream;
				sessionRef.current = sessionId;
				stream.onmessage = (event) => {
					let frame;
					try {
						frame = JSON.parse(event.data);
					} catch {
						return;
					}
					if (frame.type === "data") {
						const bytes = decodeBase64(frame.bytes);
						const start = frame.seq - bytes.length;
						const skip = Math.max(0, receivedRef.current - start);
						const fresh = skip >= bytes.length ? null : bytes.subarray(skip);
						if (fresh !== null && termRef.current !== null) termRef.current.write(fresh);
						if (fresh !== null) rxRef.current += fresh.length;
						receivedRef.current = Math.max(receivedRef.current, frame.seq);
						return;
					}
					if (frame.type === "ready") {
						setConnected(true);
						setBusy(false);
						setError(null);
						return;
					}
					if (frame.type === "params") {
						shared.options = frame.options;
						return;
					}
					if (frame.type === "closed") {
						setConnected(false);
						setBusy(false);
						shared.sessionId = null;
						sessionRef.current = null;
						setError(frame.error ?? "串口已断开");
					}
				};
				stream.onerror = () => {
					// EventSource 会自己重连；只有 Host 端会话真的没了才会 404 到这里。
					setConnected(false);
				};
			}

			/** 打开串口并接上流。 */
			const connect = React.useCallback(async (takeover) => {
				setBusy(true);
				setError(null);
				setConflict(null);
				try {
					const payload = await postJson(`${API}/open`, {
						path, baud, dataBits, parity, stopBits, flow,
						takeover: takeover === true
					});
					shared.sessionId = payload.session.sessionId;
					shared.path = payload.session.path;
					shared.options = payload.session.options;
					sessionRef.current = shared.sessionId;
					if (termRef.current !== null) {
						termRef.current.reset();
						termRef.current.write(`\u001b[2m── 已打开 ${payload.session.path} @ ${payload.session.options.baud} ${payload.session.options.dataBits}${String(payload.session.options.parity)[0].toUpperCase()}${payload.session.options.stopBits} ──\u001b[0m\r\n`);
					}
					attach(shared.sessionId);
					setConnected(true);
					refreshPorts();
					termRef.current?.focus();
				} catch (openError) {
					const message = String(openError.message ?? openError);
					// 「已被占用」不是普通错误：说明 Host 上还挂着一个会话，给用户接管的选择。
					if (message.includes("占用")) {
						setConflict({ path, message });
					} else {
						setError(message);
					}
					setConnected(false);
				} finally {
					setBusy(false);
				}
			}, [path, baud, dataBits, parity, stopBits, flow, refreshPorts]);

			/** 断开并关闭 Host 会话。 */
			const disconnect = React.useCallback(async () => {
				const sessionId = sessionRef.current;
				detach();
				shared.sessionId = null;
				sessionRef.current = null;
				setConnected(false);
				if (termRef.current !== null) termRef.current.write("\r\n\u001b[2m── 已断开 ──\u001b[0m\r\n");
				if (sessionId === null) return;
				try {
					await postJson(`${API}/close`, { session: sessionId });
				} catch {}
				refreshPorts();
			}, [refreshPorts]);

			/**
			 * 测试连接：让 Host 开一个临时会话，发一个回车，看线路上有没有可读数据。
			 * 不会留下会话，也不会影响已连接的会话。
			 */
			const testConnection = React.useCallback(async () => {
				setTesting(true);
				setProbe(null);
				setError(null);
				try {
					const payload = await postJson(`${API}/probe`, {
						path, baud, dataBits, parity, stopBits, flow, timeoutMs: 1500
					});
					setProbe(payload.result);
				} catch (probeError) {
					setProbe({ ok: false, error: String(probeError.message ?? probeError) });
				} finally {
					setTesting(false);
				}
			}, [path, baud, dataBits, parity, stopBits, flow]);

			/** 运行期改线路参数。 */
			const reconfigure = React.useCallback(async () => {
				const sessionId = sessionRef.current;
				if (sessionId === null) return;
				try {
					await postJson(`${API}/set`, { session: sessionId, baud, dataBits, parity, stopBits, flow });
					setError(null);
				} catch (setError_) {
					setError(String(setError_.message ?? setError_));
				}
			}, [baud, dataBits, parity, stopBits, flow]);

			/**
			 * 向串口写字节。
			 * @param bytes - 待发送字节。
			 * @param fromKeyboard - 是否来自终端键盘（用于本地回显）。
			 */
			const sendBytes = React.useCallback(async (bytes, fromKeyboard) => {
				const sessionId = sessionRef.current;
				if (sessionId === null) return;
				if (fromKeyboard === true && echoRef.current && termRef.current !== null) termRef.current.write(bytes);
				try {
					await postJson(`${API}/write`, { session: sessionId, data: encodeBase64(bytes) });
					txRef.current += bytes.length;
				} catch (writeError) {
					setError(String(writeError.message ?? writeError));
				}
			}, []);

			/** 发送一个控制序列。 */
			const sendRaw = (text) => {
				sendBytes(new TextEncoder().encode(text), true);
			};

			/** 快捷发送行提交。 */
			const submitCommand = (event) => {
				event.preventDefault();
				if (command === "") return;
				sendBytes(new TextEncoder().encode(`${command}\r`), true);
				setCommand("");
			};

			const currentPort = ports.find((candidate) => candidate.path === path);
			const portHint = currentPort !== undefined ? portSummary(currentPort) : path;

			const pillClass = error !== null ? "dsr-pill err" : testing ? "dsr-pill busy" : connected ? "dsr-pill on" : "dsr-pill";
			const pillText = error !== null ? "异常" : testing ? "测试中" : connected ? "已连接" : "未连接";

			/** 测试结果卡片。 */
			function probeCard() {
				if (probe === null) return null;
				if (probe.ok === false) {
					return h("div", { className: "dsr-probe bad" },
						h("div", { className: "dsr-probe-title" }, "测试失败"),
						h("div", { className: "dsr-probe-body" }, probe.error));
				}
				const active = probe.verdict === "active";
				const garbled = probe.verdict === "garbled";
				const tone = active ? "ok" : garbled ? "warn" : "warn";
				const title = active ? "线路正常" : garbled ? "收到乱码" : "无数据返回";
				const body = active
					? `端口可打开，${probe.elapsedMs} ms 内收到 ${formatBytes(probe.received)} 可读数据（${probe.baud} baud）。`
					: garbled
						? `端口可打开，收到 ${probe.received} 字节但可读率仅 ${Math.round(probe.readableRatio * 100)}% —— 波特率或校验位很可能不对。`
						: `端口可以打开，但 ${probe.elapsedMs} ms 内一个字节都没收到。对端可能没在输出，或需要先按一下回车。`;
				return h("div", { className: `dsr-probe ${tone}` },
					h("div", { className: "dsr-probe-title" }, title),
					h("div", { className: "dsr-probe-body" }, body),
					probe.sample !== "" ? h("div", { className: "dsr-probe-sample" }, probe.sample) : null);
			}

			return h("div", {
				className: "dsr-root",
				"data-dsh-serial-view": "",
				style: {
					// 字体栈（Monaco + 字形回退 + 中文兜底）
					...(fontInfo !== null && fontInfo.stack != null ? { "--dsr-font": fontInfo.stack } : {}),
					// 光标闪烁周期：xterm 的动画时长写死为 1s，这里用 CSS 变量覆盖
					"--dsr-blink": `${Math.round(1000 / blinkHz)}ms`
				}
			},
				// ---------------- 左侧设置栏 ----------------
				h("aside", { className: "dsr-side" },
					h("div", { className: "dsr-brand" },
						h("div", null,
							h("div", { className: "dsr-brand-title" }, "串口终端"),
							h("div", { className: "dsr-brand-sub" }, shared.path ?? path)),
						h("span", { className: pillClass },
							h("span", { className: "dsr-pill-dot" }),
							h("span", null, pillText))),

					h("div", { className: "dsr-group" },
						h("div", { className: "dsr-group-head" }, "线路"),
						h("div", { className: "dsr-fields" },
							h(Field, {
								label: "端口",
								value: path,
								disabled: connected,
								hint: portHint,
								onChange: setPath,
								choices: (ports.length === 0 ? [{ path }] : ports).map((port) => [port.path, port.path])
							}),
							h("div", { className: "dsr-row" },
								h(Field, {
									label: "波特率",
									value: String(baud),
									onChange: (value) => setBaud(Number(value)),
									choices: BAUD_CHOICES.map((value) => [String(value), String(value)])
								}),
								h(Field, {
									label: "流控",
									value: flow,
									onChange: setFlow,
									choices: FLOW_CHOICES
								})),
							h("div", { className: "dsr-row" },
								h(Field, {
									label: "数据位",
									value: String(dataBits),
									onChange: (value) => setDataBits(Number(value)),
									choices: DATA_BITS_CHOICES.map((value) => [String(value), String(value)])
								}),
								h(Field, {
									label: "校验",
									value: parity,
									onChange: setParity,
									choices: PARITY_CHOICES
								})),
							h("div", { className: "dsr-row" },
								h(Field, {
									label: "停止位",
									value: String(stopBits),
									onChange: (value) => setStopBits(Number(value)),
									choices: STOP_BITS_CHOICES.map((value) => [String(value), String(value)])
								}),
								h("div", { className: "dsr-field" },
									h("span", { className: "dsr-label" }, "扫描"),
									h("button", {
										className: "dsr-btn",
										onClick: refreshPorts,
										title: "重新扫描 /dev 下的串口设备"
									}, "刷新设备"))))),

					h("div", { className: "dsr-group" },
						connected
							? h("div", { className: "dsr-btn-row" },
								h("button", { className: "dsr-btn", onClick: reconfigure, title: "把当前参数下发到已打开的串口" }, "应用参数"),
								h("button", { className: "dsr-btn dsr-btn-danger", onClick: disconnect }, "断开"))
							: h("div", { className: "dsr-btn-row" },
								h("button", {
									className: "dsr-btn dsr-btn-primary",
									disabled: busy,
									onClick: () => connect(false)
								}, busy ? "连接中…" : "连接"),
								h("button", {
									className: "dsr-btn",
									disabled: testing,
									onClick: testConnection,
									title: "打开端口、发一个回车，看线路上有没有数据（不影响已连接的会话）"
								}, testing ? "测试中…" : "测试连接"))),

					probeCard(),

					conflict !== null
						? h("div", { className: "dsr-probe warn" },
							h("div", { className: "dsr-probe-title" }, "设备被占用"),
							h("div", { className: "dsr-probe-body" },
								`${conflict.path} 上还有一个活动会话 —— 可能是页面刷新前留下的，或设备拔插后的僵尸会话。接管会关掉它并重新打开端口。`),
							h("div", { className: "dsr-btn-row", style: { marginTop: "8px" } },
								h("button", {
									className: "dsr-btn dsr-btn-primary",
									disabled: busy,
									onClick: () => connect(true)
								}, "接管并连接"),
								h("button", {
									className: "dsr-btn",
									onClick: () => setConflict(null)
								}, "取消")))
						: null,

					h("div", { className: "dsr-group" },
						h("div", { className: "dsr-group-head" }, "快捷按键"),
						h("div", { className: "dsr-keys" },
							QUICK_KEYS.map(([label, bytes]) => h("button", {
								key: label,
								className: "dsr-kbd",
								disabled: !connected,
								onClick: () => sendRaw(bytes)
							}, label)))),

					h("div", { className: "dsr-group" },
						h("div", { className: "dsr-group-head" }, "终端"),
						// 字号
						h("div", { className: "dsr-field" },
							h("div", { className: "dsr-label-row" },
								h("span", { className: "dsr-label" }, "字号"),
								h("span", { className: "dsr-value" }, `${fontSize} px`)),
							h("input", {
								type: "range",
								className: "dsr-range",
								min: 10,
								max: 28,
								step: 1,
								value: fontSize,
								onChange: (event) => setFontSize(Number(event.target.value))
							})),
						// 光标样式
						h("div", { className: "dsr-field" },
							h("span", { className: "dsr-label" }, "光标样式"),
							h("div", { className: "dsr-seg" },
								CURSOR_STYLES.map(([value, label]) => h("button", {
									key: value,
									type: "button",
									className: cursorStyle === value ? "on" : "",
									onClick: () => setCursorStyle(value)
								}, label)))),
						// 是否闪烁
						h("div", { className: "dsr-switch-row" },
							h("div", null,
								h("div", { className: "dsr-switch-text" }, "光标闪烁"),
								h("div", { className: "dsr-switch-desc" },
									cursorBlink ? `${Math.round(1000 / blinkHz)} ms / 次` : "已关闭")),
							h("label", { className: "dsr-switch" },
								h("input", {
									type: "checkbox",
									checked: cursorBlink,
									onChange: (event) => setCursorBlink(event.target.checked)
								}),
								h("span", { className: "dsr-switch-track" }))),
						// 闪烁频率（关闭时不占地方）
						cursorBlink
							? h("div", { className: "dsr-field" },
								h("div", { className: "dsr-label-row" },
									h("span", { className: "dsr-label" }, "闪烁频率"),
									h("span", { className: "dsr-value" }, `${blinkHz.toFixed(1)} Hz`)),
								h("input", {
									type: "range",
									className: "dsr-range",
									min: 0.5,
									max: 4,
									step: 0.5,
									value: blinkHz,
									onChange: (event) => setBlinkHz(Number(event.target.value))
								}))
							: null),

					h("div", { className: "dsr-group" },
						h("div", { className: "dsr-group-head" }, "显示"),
						h("div", { className: "dsr-switch-row" },
							h("div", null,
								h("div", { className: "dsr-switch-text" }, "本地回显"),
								h("div", { className: "dsr-switch-desc" }, "对端不回声时显示本地按键")),
							h("label", { className: "dsr-switch" },
								h("input", {
									type: "checkbox",
									checked: localEcho,
									onChange: (event) => setLocalEcho(event.target.checked)
								}),
								h("span", { className: "dsr-switch-track" })))),

					h("div", { className: "dsr-meta" },
						h("span", null, "收 ", h("b", null, formatBytes(stats.rx))),
						h("span", null, "发 ", h("b", null, formatBytes(stats.tx))))),

				// ---------------- 右侧终端 ----------------
				h("section", { className: "dsr-main" },
					h("div", { className: "dsr-topbar" },
						h("span", { className: "dsr-topbar-path" }, shared.path ?? path),
						h("span", { className: "dsr-topbar-sep" }, "·"),
						h("span", null, `${baud} ${dataBits}${String(parity)[0].toUpperCase()}${stopBits}`),
						h("span", { className: "dsr-topbar-sep" }, "·"),
						h("span", null, connected ? "会话进行中" : "未建立会话"),
						h("span", { className: "dsr-topbar-sep" }, "·"),
						h("span", {
							title: fontInfo === null ? "正在准备终端字体" : fontInfo.detail,
							style: { cursor: "help" }
						}, fontInfo === null ? "字体准备中…" : `字体 ${fontInfo.label}`),
						h("span", { className: "dsr-topbar-spacer" }),
						h("button", {
							className: "dsr-btn",
							onClick: () => termRef.current?.clear(),
							title: "清屏（只清本地显示）"
						}, "清屏")),
					error !== null ? h("div", { className: "dsr-error" }, error) : null,
					h("div", { className: "dsr-screen-wrap" },
						h("div", { className: "dsr-screen", ref: screenRef }),
						renderer === "ready" && (connected || stats.rx > 0)
							? null
							: h("div", { className: "dsr-idle" },
								h("div", { className: "dsr-idle-title" },
									renderer === "failed" ? "终端渲染器加载失败" : renderer === "pending" ? "正在加载终端…" : "未连接"),
								h("div", null,
									renderer === "failed"
										? "请检查 Host 日志中 dsh-serial 的资源路由。"
										: renderer === "pending"
											? "首次打开需要加载 xterm.js"
											: "左侧选好端口与波特率后点「连接」，或用「测试连接」先探一下线路。"))),
					renderer === "ready"
						? h("form", { className: "dsr-send", onSubmit: submitCommand },
							h("input", {
								type: "text",
								value: command,
								placeholder: connected ? "输入命令后回车发送（等价于在终端里键入并回车）" : "先连接串口",
								disabled: !connected,
								onChange: (event) => setCommand(event.target.value),
								spellCheck: false
							}),
							h("button", { className: "dsr-btn dsr-btn-primary", type: "submit", disabled: !connected }, "发送"))
						: null));
		}
		//#endregion

		/** 侧边栏图标（shell 提供 size / active）。 */
		function SerialIcon({ size, active }) {
			return h("svg", {
				"data-dsh-panel-entry": PANEL_ID,
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: active ? 1.8 : 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true"
			},
				h("rect", { x: "1.75", y: "3.25", width: "12.5", height: "9.5", rx: "1.5" }),
				h("path", { d: "M5 6.5v3M3.5 8h3" }),
				h("path", { d: "M9 8h3.5" }));
		}

		/** 需要客户端服务：插槽表（侧边栏与主面板都由它宣告）。 */
		const inject = ["slots"];

		/**
		 * 挂载串口面板。
		 * @param ctx - 客户端根上下文（slots 服务）。
		 */
		function apply(ctx) {
			const slots = ctx.slots;
			ctx.effect(() => {
				const css = document.createElement("style");
				css.dataset.dshPlugin = "serial";
				css.textContent = CSS;
				document.head.appendChild(css);
				return () => css.remove();
			}, "dsh-serial: styles");
			const disposers = [];
			disposers.push(slots.inject("sidebar.panellist", () => slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: PANEL_ORDER,
				label: () => "串口"
			}, SerialIcon)));
			disposers.push(slots.inject("main", () => slots.register({
				name: "main",
				key: PANEL_ID
			}, SerialPage)));
			ctx.effect(() => () => {
				for (const dispose of disposers.splice(0)) dispose();
			}, "dsh-serial: ui mounts");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
