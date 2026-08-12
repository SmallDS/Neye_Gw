# NEye 官网与独立订阅后台

本目录是 NEye 官网、订阅订单页和官网独立管理后台。它只管理官网套餐、订单和订阅权益，不连接或修改上级目录中的业务后台、小程序与 NEye 主系统账号。

技术形态：

- 原生 HTML、CSS、JavaScript，无前端构建步骤。
- ESA Functions 处理订单、支付宝接口、TOTP 管理认证和 Webhook。
- ESA Edge KV 保存 v2_ 数据；联系人、备注、TOTP 密钥和支付配置使用 AES-GCM 加密。
- 支付宝 AI 网页应用付款采用 fetch + node:crypto 实现 RSA2 协议，不把完整 Node SDK 作为线上依赖。
- 月付和年付均为一次付款购买一个自然月或一个自然年，不自动续费。

## 页面与接口

页面：

- 官网：/
- 订阅订单：/payment.html
- 官网管理后台：/admin/（不在官网导航展示）

公开接口：

- GET /api/subscription/plans
- POST /api/payment/create
- GET /api/payment/status
- GET /api/payment/return
- POST /api/payment/notify

管理接口统一位于 /api/admin/，包括 TOTP 绑定与重置、加密支付配置、概览、套餐、订单同步、关单、退款、退款查询、订阅调整、账单下载、CSV 导出、Webhook 重试和审计日志。

支付结果只以验签后的支付宝异步通知或 alipay.trade.query 主动查询为准。同步返回只引导浏览器回到订单页，不直接把订单标记为已支付。

## ESA 部署参数

仓库连接 ESA 时填写：

- 生产分支：main
- 根目录：.
- 安装命令：留空
- 构建命令：留空
- 静态资源目录：.
- 函数入口：./esa/function.js
- Node.js 版本：控制台要求时选择 22.x

ESA 控制台负责入口、静态资源目录和环境变量配置；该项目没有线上安装或构建步骤。

如果 ESA 连接的是上级 NEye 仓库，将根目录改为 官网；其余保持不变。

## Edge KV

在 ESA 控制台进入“边缘计算与 AI > KV 存储”，创建命名空间，例如 neye-orders，并让 ESA_KV_NAMESPACE 与其完全一致。

Edge KV 是最终一致存储，数据通常数秒内同步到全球节点，文档保证最长 300 秒。因此后台会显示“数据同步中”，列表索引采用月份和哈希分片，所有新数据使用 v2_ 前缀。旧沙箱订单不会迁移或删除，也不会进入新后台。

参考：[ESA Edge KV 快速入门](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/get-started-with-edge-kv)

## 环境变量与后台安全配置

ESA Pages 控制台中的“构建信息 > 环境变量”主要提供给构建过程使用。当前这个项目的线上请求函数无法从该处读取后台安全变量，因此只填写截图中的变量会导致 `/api/admin/auth/state` 仍返回 `setupAvailable: false`。

本项目现在优先读取运行时环境变量；如果 ESA 请求函数没有提供这些变量，就从同一 Edge KV 命名空间读取受保护的运行时配置。请在 ESA 控制台的“边缘计算与 AI > KV 存储”中，在 `neye-orders` 命名空间创建以下键：

- 键名：`v2_runtime_config`
- 值：原始 JSON，不要再套一层引号，不要填写 Markdown 代码围栏

```json
{
  "ADMIN_SETUP_TOKEN": "在本地粘贴你的 ADMIN_SETUP_TOKEN",
  "ADMIN_RESET_TOKEN": "在本地粘贴你的 ADMIN_RESET_TOKEN",
  "ADMIN_DATA_KEY": "在本地粘贴你的 ADMIN_DATA_KEY",
  "ADMIN_SESSION_SECRET": "在本地粘贴你的 ADMIN_SESSION_SECRET"
}
```

上面四个值只在 ESA KV 控制台填写，不要发送给我，不要写入 Git、HTML、浏览器脚本、构建日志或普通运行日志。`ADMIN_SETUP_TOKEN` 与 `ADMIN_RESET_TOKEN` 必须不同；`ADMIN_DATA_KEY` 部署后不要更换，否则已有加密数据无法读取，订阅用户标识也会变化。截图中已有的 `ESA_KV_NAMESPACE=neye-orders` 可以保留；如果请求函数读不到它，代码默认也会使用 `neye-orders`。

KV 配置写入后等待边缘同步，再打开 `https://www.smallds.icu/admin/`。调用 `/api/admin/auth/state` 时，预期是 `setupAvailable: true`、`resetAvailable: true`；首次尚未绑定 TOTP 时 `configured: false` 是正常的。Edge KV 是最终一致存储，通常数秒内同步，官方文档说明最长可能需要 300 秒。

支付宝收款参数在 `/admin/` 的“支付配置”中维护：

- 支付环境、APP ID、商户 UID 或商户邮箱。
- 官网地址；同步返回和异步通知地址由系统按官网地址生成。
- Node.js 使用的 PKCS#1 应用私钥、支付宝公钥。
- 可选的订阅 Webhook 地址和 HMAC 签名密钥。

页面只返回配置状态和密钥指纹。密钥输入框始终为空，留空保存表示保留当前密钥；每次保存都需要一个未使用过的 6 位 TOTP。登录时刚使用的验证码不能重复用于改配置，必要时等待下一组验证码。

为兼容其他 ESA 运行时，以下变量仍可作为环境变量读取；在当前 Pages 部署中，后台安全配置以运行时 KV 记录为准：

| 变量 | 用途 |
| --- | --- |
| ESA_KV_NAMESPACE | Edge KV 命名空间，当前使用 `neye-orders` |
| ADMIN_SETUP_TOKEN | 首次绑定 TOTP 的高强度随机令牌 |
| ADMIN_RESET_TOKEN | 丢失验证器时重新绑定的独立高强度随机令牌 |
| ADMIN_DATA_KEY | AES-GCM 与联系人 HMAC 的高强度随机密钥 |
| ADMIN_SESSION_SECRET | 8 小时管理会话的高强度随机签名密钥 |

旧部署仍可使用以下支付宝变量作为支付配置迁移兜底；正常情况下支付参数保存到后台后以 Edge KV 中的加密配置为准：

| 变量 | 兼容用途 |
| --- | --- |
| AIPAY_ENV | sandbox 或 production |
| AIPAY_APP_ID | 支付宝应用 APP ID |
| AIPAY_PRIVATE_PKCS_KEY | Node.js 使用的 PKCS#1 应用私钥 |
| AIPAY_ALIPAY_PUBLIC_KEY | 支付宝公钥 |
| AIPAY_SELLER_ID / AIPAY_SELLER_EMAIL | 商户身份 |
| AIPAY_PUBLIC_BASE_URL | 官网 HTTPS 地址，默认 https://www.smallds.icu |
| AIPAY_RETURN_URL / AIPAY_NOTIFY_URL | 旧部署的回调地址 |
| SUBSCRIPTION_WEBHOOK_URL / SUBSCRIPTION_WEBHOOK_SECRET | 旧部署的订阅 Webhook |

安全要求：

- 不要把任何变量值写入 Git、HTML、浏览器脚本、构建日志或普通运行日志。
- 4 个管理员安全值建议分别使用至少 32 字节随机值。
- AIPAY_PUBLIC_KEY 是应用公钥，不是验签所需的支付宝公钥；运行时使用 AIPAY_ALIPAY_PUBLIC_KEY。
- 之前在聊天中出现过的应用私钥已视为泄露。沙箱和正式环境都必须重新生成应用密钥，并在支付宝开放平台重新匹配应用公钥后再部署。
## 首次进入后台

1. 发布完成后打开 https://www.smallds.icu/admin/。
2. 输入 ADMIN_SETUP_TOKEN。
3. 使用支持 TOTP 的验证器扫描页面本地生成的二维码。
4. 输入当前 6 位验证码完成绑定。
5. 打开“支付配置”，填写支付宝沙箱参数与新生成的 PKCS#1 应用私钥。
6. 等待验证器显示下一组 6 位验证码，确认并加密保存支付配置。
7. 后续登录只需要 6 位 TOTP，管理会话有效期为 8 小时。
8. 验证器丢失时使用 ADMIN_RESET_TOKEN 重新绑定；成功后所有旧会话立即失效。

系统不生成恢复码。当前为联调阶段，后台认证函数内限流暂时关闭；正式开放前应恢复限流并启用 ESA WAF 规则。支付配置写入需要 TOTP；套餐改价、退款、关单和权益调整显示二次确认并写入审计日志，但不重复要求 TOTP。

## ESA WAF 建议

在“安全防护 > WAF > 频次控制规则”中，以客户端 IP 为统计维度建立以下规则。先在沙箱观察误拦截，再切换为拦截：

| 请求路径 | 建议阈值 | 超限动作 |
| --- | --- | --- |
| /api/admin/auth/login | 5 次 / 60 秒 | 拦截 10 分钟 |
| /api/admin/auth/setup/start、/api/admin/auth/reset/start | 3 次 / 10 分钟 | 拦截 20 分钟 |
| /api/admin/auth/setup/confirm、/api/admin/auth/reset/confirm | 5 次 / 10 分钟 | 拦截 20 分钟 |
| PUT /api/admin/payment-config | 5 次 / 10 分钟 | 拦截 10 分钟 |
| /api/admin/ 其他接口 | 120 次 / 60 秒 | 拦截 5 分钟 |
| /api/payment/create | 20 次 / 60 秒 | 拦截 10 分钟 |

/api/payment/notify 是支付宝服务端回调，不要套用浏览器滑块或 JS 挑战。建议依据“路径为 /api/payment/notify 且请求方式为 POST”建立回调放行规则，同时保留函数内的 RSA2、APP ID、商户、订单号、金额和事件类型校验。

参考：[ESA 频次控制规则](https://help.aliyun.com/en/edge-security-acceleration/esa/user-guide/frequency-control-rules)、[ESA WAF 自定义规则](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/waf-custom-rules/)

## Webhook 契约

在后台支付配置中启用 Webhook 并保存地址与签名密钥后，系统会发送：

- subscription.activated
- subscription.extended
- subscription.adjusted
- subscription.revoked

请求头：

- X-NEye-Event-Id
- X-NEye-Timestamp
- X-NEye-Signature: sha256=十六进制签名

签名内容为 HMAC-SHA256(secret, timestamp + "." + rawBody)。

接收端应先验证时间戳、签名和事件 ID，再幂等处理。发送失败只记录为待重试，不影响支付宝通知返回；管理员可在后台手动重试。

本阶段只记录官网订阅权益并发出 Webhook，不直接开通或修改 NEye 主系统账号。

## 本地检查

不安装依赖即可运行：

    npm run check
    npm test

静态页面预览可使用任意本地静态服务器；本地 file:// 或纯静态服务器无法模拟 ESA Functions、Edge KV 与支付宝回调。

当前自动测试覆盖 TOTP 绑定、敏感配置二次验证与重放、支付配置加密和不回显、CSRF、限流、金额快照、自然月/年、RSA2 请求签名、支付宝响应验签、通知幂等、续期、部分和全额退款、退款查询、关单、账单下载以及 Webhook 签名与重试。

支付宝沙箱仍需在 ESA 测试环境完成真实联调，尤其是月付、年付、异步通知、主动查询、部分退款、全额退款、关单和昨日账单下载。

## 搜索引擎

首页允许收录并已配置 canonical、Open Graph、结构化数据、robots.txt 和 sitemap.xml。/admin/、/payment.html、管理接口和支付接口均禁止收录。

## 第三方文件

admin/vendor/qrcode.js 来自 qrcode-generator 1.4.4，按其 MIT License 使用，仅在浏览器本地生成 TOTP 二维码，不连接第三方二维码服务。
