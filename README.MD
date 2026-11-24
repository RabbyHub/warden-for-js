# Warden for JS

Warden 是一个面向 Webpack 5 的浏览器端安全加固插件。目前主要用于浏览器扩展构建，通过三层互补机制收敛第三方 npm 包可获得的能力。策略的最小单位是 **npm 包**；一方代码（`node_modules` 之外的模块）不受沙箱和 require 保护约束，也不会出现在策略文件中。

| 机制 | 保护目标 | 默认状态 |
| --- | --- | --- |
| 全局变量 Proxy 沙箱 | 限制第三方包通过 `globalThis`、`window`、`self` 和 `__webpack_require__.g` 访问浏览器全局能力 | 开启 |
| Webpack require 保护 | 限制第三方包只能加载自身、依赖图中的其它包或人工策略明确授权的目标 | 开启 |
| 关键原型冻结 | 防止敏感运行时依赖的关键内建对象和方法在业务启动后被替换 | 开启 |

Warden 属于现有 Webpack 运行时上的能力加固，不是独立 Realm，也不提供完整的 SES 式 JavaScript 隔离。防线分两层：**构建期审计是主防线**（`policy.json` 列出每个包静态用到的全局，`check.json` 以默认拒绝的白名单审批），**运行时沙箱是兜底**（拦截通过全局对象别名发起的、静态分析看不到的动态访问）。

## 快速接入

```js
const { WardenPlugin } = require("warden-for-js");

module.exports = {
  // ...
  plugins: [
    new WardenPlugin({
      dev: false,
    }),
  ],
};
```

可用选项：

```ts
export type WardenPluginOptions = {
  dev?: boolean;
  policyOverPath?: string;
  policyOutputPath?: string;
  freezePrototypes?: boolean;
  prototypeFreezeMode?: "compat" | "strict";
  protectWebpackRequire?: boolean;
  forceCheck?: boolean;
};
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `dev` | `true` | 全局沙箱的开发模式。未声明的全局访问会被放行并按包名记录到 `globalThis.__dbg_ru1n`；Webpack require 保护仍然严格阻断未授权导入 |
| `policyOverPath` | `SecSDK/policy-over.json` | 人工策略文件，相对于 Webpack `context` |
| `policyOutputPath` | `SecSDK/policy.json` | 构建生成的最终可读策略文件，相对于 Webpack `context` |
| `freezePrototypes` | `true` | 是否生成并加载关键原型冻结 bootstrap |
| `prototypeFreezeMode` | `"compat"` | 原型保护模式；`compat` 锁定既有成员并保留必要扩展点，`strict` 额外冻结 `Object.prototype` 并移除 `Function.prototype.toString` 兼容例外 |
| `protectWebpackRequire` | `true` | 是否保护第三方模块工厂收到的 `__webpack_require__` |
| `forceCheck` | `!dev` | 构建检查发现未获批准的全局权限、三方包越界依赖或对 Webpack 运行时内部名的引用时是否终止构建；生产模式默认终止，显式关闭时逐条 `console.warn` |

`freezePrototypes` 与 `protectWebpackRequire` 相互独立。关闭原型冻结不会关闭 require 保护，反之亦然。

## 包的命名

策略以包名为键，包名取自模块文件路径中的 `node_modules` 层级。包通过自带的 `node_modules` 目录携带其它包时，用 ` > ` 连接：

| 模块路径 | 包名 |
| --- | --- |
| `node_modules/a/lib/index.js` | `a` |
| `node_modules/@scope/a/index.js` | `@scope/a` |
| `node_modules/a/node_modules/b/index.js` | `a > b` |
| `node_modules/a/node_modules/@scope/b/node_modules/c/x.js` | `a > @scope/b > c` |

`a > b` 与顶层的 `b` 是两个独立的包，各有各的策略。`.pnpm` 这类以 `.` 开头的存储目录不算作一层。

没有文件路径的模块（`resolve.fallback: false` 产生的 ignored 模块、external、`data:` URI 等）归属于引入它的模块所在的包；`require.context` 生成的 context 模块按其目录归属。包名只取自解析后的真实文件路径，请求串中的查询参数或 `!=!` 语法无法让模块冒充其它包。

## 一、全局变量 Proxy 沙箱

Warden 会分析并改写 `node_modules` 中实际参与打包的 JavaScript 模块。启用沙箱的模块会以类似下面的结构运行：

```js
const g = __webpack_require__.g;

((globalThis, window, self, __webpack_module_cache__, webpackChunkapp) => (() => {
  "use strict";
  // 原模块工厂代码
})())(g, g, g);
```

- 外层参数把 `globalThis`、`window`、`self` 换成所属包的沙箱。模块里出现裸的 `top`、`parent`、`frames` 时，它们也会作为参数从沙箱取值（`g.top` 等），在顶层页面里得到的同样是沙箱。
- 外层参数还遮蔽了 Webpack 运行时的内部名：启动闭包里的 `__webpack_module_cache__`，以及 chunk 加载全局（`output.chunkLoadingGlobal`、`output.hotUpdateGlobal`）。前者能直接读到任意模块的导出，后者会把未受保护的 `__webpack_require__` 交给 push 进来的回调。三方模块静态引用这些名字还会被构建检查报告，且永远不会变成授权。关闭了沙箱但仍受 require 保护的包同样带这层遮蔽。
- 内层函数让模块拥有自己的作用域，模块顶层声明 `const self`、`let window` 之类不会与参数冲突。
- 内层函数是严格模式：非严格代码里 `(function () { return this })()` 会拿到真实全局对象，严格模式下得到 `undefined`。原本就是严格模式的模块（ESM、带 `"use strict"` 的 CommonJS）不受影响；非严格模块如果无法按严格模式解析，构建会失败并提示。确实需要保持非严格的包可以在 `policy-over.json` 里设置 `"strict": false`，该包会在 `policy.json` 中标出。

构建无法解析任何可用源码表示时会直接失败，不再静默生成空策略；多个可解析源码表示的访问结果取并集，避免 loader 前后表示差异漏掉能力。为控制运行时开销，静态可确定的裸全局标识符保持原生词法访问，不会统一改写成 `globalThis[...]`；Proxy 保护仍针对全局对象别名及动态属性路径。

因此模块内通过 `globalThis`、`window`、`self` 或 Webpack 的全局对象 helper 发起的操作都会经过同一个 Proxy。`globalThis.window`、`globalThis.self` 和 `globalThis.globalThis` 也会继续返回当前包的沙箱，而不是泄露真实全局对象。

沙箱工厂由 Warden 的 Webpack module-execution interceptor 私有持有。interceptor 根据 module ID 查到所属的包，再把该包的沙箱通过私有且只读的 `__webpack_require__.g` 交给模块；同一个 Webpack runtime 内，一个包的所有模块共用一个沙箱实例。页面全局和 Worker 全局均不会安装沙箱工厂，模块也不能传入任意规则自行创建沙箱。

### 权限模型

每个包拥有独立的全局变量规则表，内容是该包所有被打包模块的访问并集：

- `r`：允许读取、存在性检查和属性描述符查询。
- `rw`：包含读取权限，并允许赋值、删除和 `defineProperty`。
- 未声明属性：生产模式读取返回 `undefined`，写入被拒绝；开发模式放行并记录实际访问。
- 标准 ECMAScript 内建对象的读取默认放行，`eval` 除外。
- 已知浏览器全局函数会绑定到真实全局对象，以保持 `setTimeout`、`fetch`、`addEventListener` 等宿主 API 的调用兼容性。

沙箱实现了以下 Proxy 陷阱：

```text
get / set / has / deleteProperty / defineProperty
getOwnPropertyDescriptor / ownKeys
getPrototypeOf / setPrototypeOf
isExtensible / preventExtensions
```

反射操作与普通属性访问使用同一套权限。Proxy handler 会冻结；传入的规则首先复制到 null-prototype 对象后再冻结，因此污染 `Object.prototype` 不能伪造包的权限。沙箱以真实 `globalThis` 为 target，但不会冻结这个 Proxy 或真实全局对象。

### 开发模式与生产模式

`dev: true` 用于发现缺失的全局权限：未声明访问会继续执行，并按包名记录到 `globalThis.__dbg_ru1n`，其结构可以直接整理进 `policy-over.json`。`dev: false` 才会执行严格的全局读写限制。

这个开关不影响 Webpack require 保护。无论开发或生产模式，未授权导入都会立即抛错。

## 二、Webpack `__webpack_require__` 能力保护

开启 `protectWebpackRequire` 后，Warden 会为每个 Webpack runtime 安装模块执行 interceptor。第三方模块的工厂不会收到原始 require，而会收到所属包的受保护 Proxy；一方模块的工厂原样拿到 Webpack 的 `__webpack_require__`，不做任何限制。

一个包的模块可以加载：

- 同一个包内的任意模块；
- 依赖图显示该包会加载的其它包（包级授权：`a` 依赖 `b` 的任一模块，即可加载 `b` 的全部模块）；
- 依赖图或人工策略明确指向的一方模块，按单个模块授权。

构建阶段根据最终 `ModuleGraph`、`ChunkGraph` 和模块 ID 生成授权关系：

- 同步依赖、动态 import、context、weak context、循环依赖等均从 Webpack 的实际连接中解析，并对模块所在的全部 runtime 取并集。
- inactive 连接不会进入授权表；`TRANSITIVE_ONLY` 连接会递归展开。
- 第三方模块会退出 scope-hoisting，保证一个模块工厂只属于一个包；一方模块之间的 concatenation 不受影响。
- 动态 chunk 后续注册的模块仍经过相同 interceptor。
- interceptor 遇到策略中不存在的 module ID 会直接抛错，不会把未知模块当作一方代码放行。

受保护 require 只暴露所属包的模块在代码生成阶段真正需要的 runtime helper：

- `.g` 是包私有的虚拟属性，不再改写共享 Webpack runtime 的全局对象。
- `.m` 和 `.c` 只有在代码生成明确要求对应 capability 时才可见，且只列出该包可加载的模块；工厂项只返回不可调用的占位包装，缓存项只返回不可替换 `exports` 的冻结快照，不暴露原始工厂或 module record。
- `.t` 等可能间接加载模块的 helper 会再次校验目标 ID。
- `.i`、未知 helper、`constructor`、`prototype`、`__proto__`、构造调用以及属性写入、删除和 `defineProperty` 都会被拒绝。
- 其余函数型 helper 通过冻结包装调用，对象型 helper 通过递归只读视图暴露；`call`、`apply` 和 `bind` 仍可使用，但调用的仍是受保护 require。

拒绝时抛出的错误带有固定错误码：

```js
error.code === "WARDEN_WEBPACK_REQUIRE_DENIED";
error.callerPackage; // 发起方包名
error.requestedModuleId; // 被请求的 module ID
```

错误信息包含发起方包名、目标 module ID，以及目标所属的包名（目标是第三方模块时）。

### 人工追加 require 权限

自动依赖以外的授权写入 `policy-over.json`，键是发起方包名：

```json
{
  "example": {
    "webpackRequire": {
      "allow": ["other-package", "example > nested", "./src/shared/util.ts"]
    }
  }
}
```

`allow` 的每一项可以是包名，也可以是以 `./` 开头、相对于项目根目录的一方模块路径（与 `policy.json` 中 `require` 的写法一致）。发起方不是已打包的包，或目标既不是已打包的包也不是一方模块时，构建会失败。

顶层的 `enable: false` 只关闭该包的全局 Proxy 沙箱，不会关闭 require 保护。require 保护只能通过插件级 `protectWebpackRequire: false` 全局关闭。

## 三、关键原型冻结

开启 `freezePrototypes` 后，Warden 会发射同源的 `warden-prototype-freeze.js`，并保证它先于策略 runtime 和业务脚本执行。

当前冻结范围包括：

- `Boolean`、`Number`、`BigInt`、`String`、`Symbol`。
- `Array`、`RegExp`、`Promise.prototype`、`Map`、`Set`、`WeakMap`、`WeakSet`。
- `Error.prototype`、`AggregateError`、`SuppressedError` 及全部原生错误子类；compat 模式保留 V8 调试钩子 `Error.stackTraceLimit` 和 `Error.prepareStackTrace` 可修改。
- `DisposableStack`、`AsyncDisposableStack`（环境存在时）。
- `WeakRef`、`FinalizationRegistry`、`Iterator`（环境存在时）。
- `ArrayBuffer`、`SharedArrayBuffer`、`DataView` 和全部具体 typed array 构造器及其原型。
- `Atomics`、`Intl` 命名空间，以及环境提供的全部 `Intl` 构造器及其原型。
- 环境存在时的 `Crypto`、`CryptoKey`、`SubtleCrypto`、`TextEncoder`、`TextDecoder`。
- `Proxy`、`JSON`、`Math`。

保护清单集中定义在 `src/prototype-protection.ts`。测试会校验沙箱默认放行的每个 ECMAScript 全局都在清单中被明确分类，新增全局但遗漏保护策略时会导致测试失败。

`compat` 和 `strict` 模式都会冻结 `crypto.subtle` 单例及其实际原型，阻止对 `digest`、`encrypt` 等 Web Crypto 方法进行实例遮蔽、重定义或删除。

同时，默认的 `compat` 模式为兼容现有生态保留以下扩展点：

- `Object`、`Object.prototype`、`Function`、`Function.prototype`、`Date` 和 `Date.prototype` 不会被整体冻结，但它们启动时已经存在的成员会被锁定；仍允许增加新成员，也允许派生对象创建同名自有属性。
- `Function.prototype.toString` 是既有成员中的明确例外，保留监控 SDK 改写并恢复它的能力。
- `Reflect` 对象，允许 `reflect-metadata` 添加新 API。
- `Promise` 构造器，兼容 Dexie 等库临时替换并恢复 Promise 静态方法；`Promise.prototype` 仍冻结。
- typed array 共享构造器和共享原型保持可扩展，但其既有静态方法和原型方法会被锁定；`Buffer` 等子类仍可定义自己的 `from`、`toString`、`includes`、`slice`。

锁定方式允许派生函数或实例创建同名自有属性，避免破坏 `fn.call = value`、`obj.toString = value` 或 Buffer 子类覆盖 inherited typed-array 方法一类代码。

`prototypeFreezeMode: "strict"` 会进一步深度冻结 `Object`、`Function`、`Date`、`Promise` 构造器及其原型、共享 TypedArray 祖先、迭代器/生成器/异步生成器等隐藏 intrinsic 原型，以及原型方法函数和 `Array.prototype[Symbol.unscopables]` 一类嵌套对象。compat 模式仍保留前述生态兼容扩展点。

直接修改已锁定目标会抛出明确错误，例如：

```text
TypeError: [Warden] Modification of locked target "Reflect.get" is not allowed
```

可选 API 不存在时会跳过；对已经存在的目标，如果锁定或结果校验失败，bootstrap 会停止业务启动并报告具体目标。

## 运行时资产与加载顺序

| 运行环境 | 加载方式 |
| --- | --- |
| 普通 HTML / MV2 background page | 在所有 HTML 的 `<head>` 首位同步插入 `warden-prototype-freeze.js`（若开启）、`warden-policy-runtime.js`、业务脚本 |
| MV3 service worker | 从 `manifest.json` 识别 `background.service_worker`，在业务代码前执行冻结 bootstrap，再 `importScripts("warden-policy-runtime.js")` |
| manifest content script（默认隔离世界） | 策略封装在 runtime 闭包中，并在脚本首行执行原型冻结 bootstrap |
| `world: "MAIN"` content script / `pageProvider.js` | 策略封装在各自 runtime 闭包中，不向网页 MAIN world 注入原型冻结脚本 |

所有 HTML 注入均使用外部同源脚本，不生成内联代码，适配浏览器扩展 CSP。嵌套 HTML 会根据 `publicPath` 或相对目录生成正确引用。

外部页面和 Worker 共用的策略数据保存在 `warden-policy-runtime.js`。它是一张按包组织的表：每个包一行（包名、全局规则、可用的 runtime helper、可加载的包、额外可加载的模块 ID、自身的模块 ID），外加一方模块 ID 列表。该文件在入口模块执行前完成结构校验和冻结，并安装不可写、不可配置的 `globalThis.__wardenPolicy`；它只提供不可变策略记录的查询，不提供创建沙箱的能力，真正的沙箱工厂位于各 Webpack runtime 的闭包中。`content-script` 与 `pageProvider` 入口则把同样格式、只含自身模块的表内联到各自的 runtime 闭包，避免依赖页面 MAIN world 的共享策略。

## Policy 文件

三个策略文件都以[包名](#包的命名)为键。

### 构建产物 `policy.json`

`policy.json` 是便于审计的最终有效策略，而不是运行时存储格式。它应当纳入版本管理，变更随代码评审：

```json
{
  "example": {
    "enable": true,
    "require": [
      "./package.json",
      "example > nested",
      "other-package"
    ],
    "global": {
      "chrome": "r",
      "navigator": "rw"
    }
  },
  "legacy": {
    "enable": false
  }
}
```

- `enable` 表示该包是否启用全局 Proxy 沙箱。
- `strict` 只在包通过 `policy-over.json` 退出强制严格模式时出现（值为 `false`）。
- `require` 是该包除自身模块外最终允许加载的目标，包括自动依赖与人工追加权限：包名表示可加载该包的全部模块；以 `./` 开头的项是单个一方模块；`webpack:` 开头的项是 Webpack 生成的一方模块（例如一方目录上的 context 模块）。
- `global` 是该包最终允许访问的全局变量及权限，为包内所有被打包模块的并集。
- `disallow` 是该包显式拒绝访问的全局变量。
- 空的 `require`、`global` 和 `disallow` 会被省略。
- 如果一个包最终只有 `"enable": true`，整个条目会被省略；`"enable": false` 和 `"strict": false` 始终保留。
- 一方模块不会作为键出现。

动态属性名无法完整表示为静态 `global` 字段，但运行时通过 Proxy 发起的动态访问仍会按实际属性名校验。构建不会为这类访问打印 warning。

### 三方包依赖边界

Warden 会检查最终 `policy.json` 中的 `require` 权限：如果一个包被允许加载以 `./` 开头的一方模块，且目标文件名不是 `package.json`，则视为三方包引用一方代码。`package.json` 只提供包元数据，`webpack:` 表示 Webpack 生成的模块，二者都属于安全目标。自动依赖和 `policy-over.json` 人工追加的 require 权限使用同一检查口径。

开发模式默认逐条输出 `console.warn`；生产模式（`dev: false`）默认汇总全部越界依赖并终止构建。可通过显式 `forceCheck` 覆盖默认值。该检查依赖 `protectWebpackRequire` 生成最终 `require` 策略；关闭 require 保护后，`policy.json` 不包含相应依赖关系，因此不会执行这项边界判断。

### 全局权限白名单 `check.json`

如果 Webpack `context` 下存在 `SecSDK/check.json`，Warden 会在构建阶段用它审批最终 `policy.json` 中的全部全局权限，**默认拒绝**：键是全局名，值是允许获得该全局的包名正则数组。

```json
{
  "setTimeout": ["."],
  "document": [
    "^react-dom$",
    "^antd"
  ],
  "chrome": [
    "^webextension-polyfill$"
  ],
  "fetch": []
}
```

- 一个包拿到的每个全局都必须在 `check.json` 里有对应的键，并且包名命中其中任一正则；全局名没有列出，或没有正则命中，都算违规。
- `["."]` 表示对所有包开放，适合定时器、`console` 这类不带能力的全局；空数组表示任何包都不允许。
- 正则匹配的是 `policy.json` 的键，即包名。`^antd` 同时匹配 `antd` 和嵌套在它下面的 `antd > x`，需要精确匹配时写成 `^antd$`。
- `r` 与 `rw` 使用同一套白名单；`policy-over.json` 人工追加的权限、关闭了沙箱的包同样参与检查。
- 标准 ECMAScript 内建对象的读取不进入 `policy.json`，也就不需要列出。

开发模式默认对每个违规的“包 + 全局名”输出一条 `console.warn`；生产模式（`dev: false`）默认汇总全部违规并终止构建。可显式设置 `forceCheck` 覆盖默认行为。

`check.json` 不存在时整项检查跳过（此时没有任何全局审批，只剩运行时兜底）；文件存在但 JSON 结构、数组项或正则表达式无效时始终终止构建。

审批一个全局时需要知道：下列全局可以引出真实全局对象或真实 DOM，拿到之后的动态访问不再经过沙箱，应当只批给确实需要的包——`document` 及任何 DOM 节点/事件类（`Node`、`Element`、`Event` 的 `target`/`view`）、`EventTarget`、`addEventListener` 及各类 `on*` 事件处理属性、`Window` 等全局接口对象、`eval`、`chrome`。

### 人工策略 `policy-over.json`

```json
{
  "example": {
    "enable": true,
    "global": {
      "allow": {
        "chrome": "r",
        "navigator": "rw"
      },
      "disallow": ["fetch", "WebSocket"]
    },
    "webpackRequire": {
      "allow": ["other-package"]
    }
  },
  "example > nested": {
    "enable": false
  },
  "legacy-sloppy": {
    "strict": false
  }
}
```

人工 `global.allow` 会覆盖同名自动检测权限，`webpackRequire.allow` 会追加到依赖图授权，`enable: false` 关闭整个包的全局沙箱，`strict: false` 让该包的非严格模块保持非严格（其中的函数可以通过 `this` 拿到真实全局对象）。键写成文件路径（包含 `node_modules`）时构建会失败并提示改用包名。

`global.disallow` 按包显式拒绝访问，并优先于 `global.allow` 和 `check.json`。构建只要检测到对应全局访问，例如裸 `fetch()` 或 `window.fetch`，就会报错。无法静态解析的动态属性访问由运行时沙箱拒绝。这两项检查在开发模式下同样生效。规则适用于启用严格全局沙箱的包，目标为宿主全局变量，例如 `fetch`、`WebSocket` 和 `document`。

## 安全边界

使用 Warden 时需要注意以下边界：

- 全局 Proxy 沙箱和 require 保护都只作用于 `node_modules` 中的第三方包；一方代码被视为可信，既不进入沙箱，也不受 require 限制。
- 策略的最小单位是包：同一个包的模块共享全局权限和 require 权限，Warden 不隔离包内部的模块；对其它包的授权也是整包授权。
- 静态可确定的裸全局标识符按设计保持原生词法访问，不经过 Proxy；这类访问由构建期分析写入 `policy.json`，并由 `check.json` 白名单审批。没有 `check.json` 的项目只有运行时兜底。
- 运行时沙箱不是完整隔离：已获批准使用 `document`、`EventTarget`、事件监听等全局的包，可以经由 DOM 节点或事件对象拿到真实全局对象（Proxy 只包装 `document` 的第一跳），此后的动态访问不受约束。这些全局的审批本身就是信任决定。
- `strict: false` 的包可以通过非严格函数的 `this` 拿到真实全局对象。
- 被允许 require 的包，其导出对象是共享且可变的：一个包可以改写它能加载到的其它包的导出（原型冻结只覆盖内建对象）。
- 动态生成代码、未被解析器看到的代码和提前保存的真实引用同样不在 Proxy 保证内。
- 不经过 Webpack 模块图的脚本（直接拷贝进产物的第三方文件）完全不受约束；通过符号链接解析到 `node_modules` 之外的包会被当作一方代码。
- Symbol 属性当前默认允许读写，以保持宿主对象和运行时协议兼容。
- Webpack runtime、RuntimeModule 和 chunk loader 是受信任基础；保护对象是传给业务模块工厂的 require。
- 第三方模块会主动退出 concatenation；只有同时关闭 require 保护和该包的沙箱时，它才可能与其它模块合并进同一个工厂。
- 默认 `prototypeFreezeMode: "compat"` 下 `Object.prototype` 仍可扩展，因此不等于消除全部普通对象原型污染路径；需要阻断这一路径时使用 `"strict"`。
- Warden 不冻结应用内部的 Keyring、Buffer 或其他业务类，也不替代私钥材料的对象级生命周期管理。
- manifest 默认隔离世界的 content script 会执行关键原型冻结；显式 `world: "MAIN"` 的 content script 和 `pageProvider.js` 不冻结网页原型，避免改变被访问页面的 JavaScript 行为。
- 能进行动态代码生成或已提前获得真实对象引用的代码，不应被当作完全不可信的任意 JavaScript 放入当前沙箱；需要这种隔离时应使用独立 Realm、Worker 或进程边界。

## 源码架构与维护

包根入口保持精简，Webpack 编译期逻辑与生成到浏览器中的运行时代码分开维护：

| 模块 | 职责 |
| --- | --- |
| `src/index.ts` | 公共入口，只导出 `WardenPlugin` 和 `WardenPluginOptions` |
| `src/plugin/warden-plugin.ts` | 注册 Webpack 生命周期 hook，串起下面各模块 |
| `src/plugin/packages.ts` | 由模块路径得到包名，判定模块归属与一方模块的标签 |
| `src/plugin/global-analysis.ts` | 选择分析源码、提取模块的全局访问、改写 `bind`、检查能否按严格模式渲染 |
| `src/plugin/package-policy.ts` | 从最终模块图汇总每个包的全局权限与 require 权限，合并人工策略，产出运行时策略表和 `policy.json` 内容 |
| `src/plugin/policy-files.ts` | 读取人工策略和全局白名单，执行全局权限与依赖边界检查，写入 `policy.json` |
| `src/plugin/runtime-assets.ts` | 发射冻结/策略资产，并处理 HTML、MV2、MV3 的加载顺序 |
| `src/plugin/contracts.ts` | 插件选项和策略文件结构等共享契约 |
| `src/policy-runtime.ts` | 运行时策略表的格式、解码校验，以及共享策略资产的源码 |
| `src/webpack-require.ts` | 注入 Webpack runtime 的模块执行 interceptor 与受保护 require |
| `src/globals.ts`、`src/global/` | 能力清单、AST 全局访问分析、bind 改写和 Proxy 沙箱 |
| `src/prototype-freeze.ts`、`src/prototype-protection.ts` | 关键原型冻结 bootstrap 及其保护清单 |

一次编译的主要数据流是：

```text
模块源码分析（按模块记录全局访问）
    ↓
代码生成后按包汇总全局权限与 require 权限
    ↓
人工策略合并，全局白名单、依赖边界与运行时内部名审计
    ↓
policy.json 写入、runtime 资产发射与页面/Worker 注入
```

维护生成代码时需要遵守以下约束：

- `mkCompartmentFactory`、`decodePolicyTable`、`installModuleGuard`、`createProtectedRequire` 和 `createGlobalRequire` 都会通过 `toString()` 写入生成代码，函数体必须自包含，不能引用模块作用域中的常量、import 或辅助函数；需要的数据以参数形式传入。
- 这些运行时函数在模块执行期间只使用启动时捕获的内建函数和下标循环，不依赖可能被第三方代码改写的原型方法。
- 策略中的一方模块路径统一为相对于 Webpack `context`、以 `./` 开头的 POSIX 路径；生成模块使用稳定的 `webpack:` 标识。
- 不要随意调整 Webpack hook 或 `processAssets` stage。模块分析、runtime policy 生成、资产发射和最终注入依赖现有先后顺序。
- `src/index.ts` 是对外入口，包根导出应保持稳定。

## 开发与验证

```bash
npm run check
npm test
```

`npm run check` 只执行 TypeScript 类型检查；`npm test` 会先构建 `dist/`，再运行全部 Node.js 测试。

测试覆盖包名解析、全局别名分析、全局 Proxy 反射陷阱、默认拒绝的全局白名单、强制严格模式、运行时内部名遮蔽、关键原型兼容性、策略表校验、包级 require 授权、嵌套包、Webpack 同步与异步依赖、context、concatenation、HMR、require 旁路以及 HTML/MV2/MV3 资产加载顺序。`test/exports.test.js` 额外锁定包根和深层模块的运行时导出。
