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

官网提供月付和年付订单页。提交后生成订单号并暂存当前浏览器；支付按钮当前返回“未配置支付方式”，不会发起真实扣款。接入真实支付时，将 `payment.js` 中的支付按钮替换为后端创建支付单和跳转收银台的接口即可。
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
