# NEye 官网

这是基于 NEye 现有客户、验光、配镜和取镜通知能力制作的独立静态官网，不依赖额外前端框架或构建工具。

## 本地预览

仓库已安装 Vite 依赖时，在仓库根目录运行：

```powershell
cd .\官网
node ..\frontend\admin-web\node_modules\vite\bin\vite.js --host 127.0.0.1 --port 4173
```

然后打开 <http://127.0.0.1:4173>。也可以使用任意静态文件服务器直接托管此目录。

## 部署到阿里云 ESA Pages

本仓库是原生 HTML、CSS、JavaScript 静态站点，没有 `package.json`，不需要 npm 构建。

如果 ESA 直接连接本仓库：

- 项目根目录：`.`
- 构建命令：留空
- 输出目录：留空；如果控制台要求填写，填 `.`
- 首页文件：`index.html`

如果 ESA 连接的是上级 `NEye` 仓库，则把项目根目录填为 `官网`，构建命令留空，输出目录留空或填 `.`。

页面中的产品界面使用合成数据，仅用于展示信息结构；正式上线前可根据实际品牌资产、联系入口和部署地址替换对应文案。
## 订阅与支付流程

官网提供月付和年付订单页。订单创建、金额计算、支付宝签名、支付跳转和异步通知均由 ESA 边缘函数处理；月付金额为 9.90 元，年付金额为 99.99 元。当前接入支付宝沙箱，支付结果以服务端异步通知验签后的订单状态为准。

## 搜索引擎收录

当前已配置：

- 首页允许搜索引擎抓取，并补充了页面标题、描述、canonical、社交分享信息和结构化数据。
- 订单页使用 noindex，避免订单提交界面出现在搜索结果中。
- 根目录已加入 robots.txt 和 sitemap.xml，地址为 https://www.smallds.icu/robots.txt 与 https://www.smallds.icu/sitemap.xml。

上线检查：

1. 确保 https://www.smallds.icu/ 可以公开访问，不需要登录，也不要使用本地 file:// 地址或带权限限制的预览地址。
2. 在 Google Search Console、Bing Webmaster Tools 和百度搜索资源平台验证 www.smallds.icu。
3. 提交 https://www.smallds.icu/sitemap.xml。
4. 发布后在 Google Search Console 检查首页并请求编入索引；后续用 site:www.smallds.icu 查询收录状态。

搜索引擎是否收录由平台自行评估，提交 sitemap 只是通知，不代表一定收录。先保证页面公开可访问、内容真实有用、移动端体验正常，再持续更新页面内容。
## ESA 支付接入

仓库已包含 ESA 函数入口 esa/function.js 和配置文件 esa.jsonc。连接 GitHub 仓库时使用：

- 生产分支：main
- 项目根目录：.
- 构建命令：留空
- 输出目录：.
- 函数入口：./esa/function.js

在 ESA 控制台创建 Edge KV 存储空间，名称建议为 neye-orders。该名称必须与 ESA_KV_NAMESPACE 一致。Edge KV 使用最终一致性，当前适合沙箱联调和轻量订单状态；正式收款前建议按业务规模评估更强一致性的订单数据库。

在 ESA 函数和 Pages 的环境变量中配置：

- AIPAY_APP_ID：支付宝沙箱应用 ID
- AIPAY_PRIVATE_PKCS_KEY：新生成的非 Java 格式应用私钥；也可使用 AIPAY_PRIVATE_KEY 配置 PKCS8 格式私钥
- AIPAY_ALIPAY_PUBLIC_KEY：支付宝沙箱公钥
- AIPAY_GATEWAY：https://openapi-sandbox.dl.alipaydev.com/gateway.do
- AIPAY_PUBLIC_BASE_URL：https://www.smallds.icu
- AIPAY_RETURN_URL：https://www.smallds.icu/api/payment/return
- AIPAY_NOTIFY_URL：https://www.smallds.icu/api/payment/notify
- ESA_KV_NAMESPACE：neye-orders

AIPAY_PUBLIC_KEY 是应用公钥，需要在支付宝开放平台完成上传和匹配；函数端使用应用私钥签名、使用支付宝公钥验签。任何私钥都不能写入 GitHub、HTML、浏览器脚本或构建产物。你之前发送的私钥已经暴露，请先在支付宝沙箱重新生成后再配置。

接口路径：

- POST /api/payment/create：服务端按方案固定金额创建订单并生成支付宝支付表单
- POST /api/payment/notify：支付宝异步通知验签和订单状态更新
- GET /api/payment/return：支付宝同步返回验签后回到订单页
- GET /api/payment/status：订单页查询服务端订单状态
