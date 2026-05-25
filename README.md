# Aspecta Telegram Tracker

一个跑在 Railway（或任意 Node 环境）上的 Telegram 机器人：定时请求 Aspecta K 线接口，解析最新价与涨跌幅，达到阈值就通过 Telegram Bot API 推送提醒。

由后端服务请求接口，绕过浏览器 CORS 限制。

## 功能

- 定时（默认 60s）请求 Aspecta `k-line` 接口，解析 18 个固定项目
- 计算 **本轮变化**（两次查询之间，可选回看窗口）、**1H 变化**、**24H 变化**
- 默认「**60 秒内涨跌 ≥3%**」才推送（`POLL_LOOKBACK_SEC=60` 窗口 + `POLL_ALERT_PERCENT=3` 阈值），每 20 秒重叠检查一次，只抓突发拉砸
- **24H 边沿触发**：只有 24H 涨跌从阈值内**穿越**到 `DAY_ALERT_PERCENT` 之外时才报，避免持续偏离时反复刷屏
- **冷启动静默**：启动/重启后第一轮只建立基线、发一条「当前异动快照」，不会把所有已超阈值的项目一次性轰炸出来
- **合并推送**：同一轮里多个项目触发时合并成一条消息，并带 🟢/🔴 涨跌图标
- **即将上市监控**：定时查 `assets-list` 的 pre_launch 组（每 `UPCOMING_INTERVAL_SEC` 轮询一次）。**远期新项目只在首次发现时公告一次**，不会每轮刷屏；卡片带「🛑 停止提醒」按钮，点停止即静音该项目（持久化保存），`/upcoming` 里可恢复
- **临开盘特别提醒**：开盘前 `LAUNCH_SOON_MIN`（默认 30 分钟）内才开始反复提醒，发「🔥 即将开盘」卡片，每 `LAUNCH_ALERT_INTERVAL_MIN`（默认 5 分钟）一次
- **开盘后接入价格**：项目开盘后自动加入价格监控，推送一条带最新价的「🚀 已开盘」通知，之后价格异动照常推送
- **自动刷新监控列表**：定时（`REFRESH_INTERVAL_MIN`，默认 10 分钟）从 `arena-popular-assets` 同步当前活跃项目，把不在固定列表里的新项目自动纳入监控（解决「写死 18 个项目导致新币漏监控」）；也可发 `/refresh` 手动同步
- **全量播报**：定时（`DIGEST_INTERVAL_MIN`，默认 60 分钟）把「全部市场」发一次。已上市部分按**近期成交额**从高到低排序，卡片式展示价格、24H/1H、成交额、参与人数（成交额/人数取自 `arena-popular-assets` 的 `recent_volume` / `participants_count`；该接口为预发币做空盘，无市值字段，故用成交额作为规模排序）；并附即将上市（pre-launch）列表。也可发 `/all` 手动查看
- **设置卡片**：`/settings`（或菜单里「⚙️ 设置」）打开可点按调整的卡片，用 ➖/➕ 直接改本轮阈值、查询间隔、本轮窗口、24H 阈值、冷却，并一键暂停/恢复，改完原地刷新、立即生效
- Telegram 命令交互：查询、排行、订阅话题、暂停/恢复、运行时改阈值
- `/health` 接口（Node 内置 http，零依赖），供 Railway 健康检查与保活

## 部署到 Railway

1. 把本仓库连接到 Railway，新建一个服务（Node）。
2. 在 **Variables** 里设置环境变量（见下表，不要写进代码）。
3. Railway 会自动执行 `npm install` 并 `npm start`。
4. 部署成功后，把机器人拉进群，进入目标话题发 `/subscribe` 即可开始接收提醒（无需配置 `TELEGRAM_CHAT_ID`）。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | — | 找 @BotFather 创建机器人得到的 Token |
| `TELEGRAM_CHAT_ID` | 否 | — | 默认订阅的 chat_id（重启后自动恢复；也可只用 `/subscribe`） |
| `POLL_INTERVAL_SEC` | 否 | `20` | 查询间隔（秒），最小 10 |
| `POLL_ALERT_PERCENT` | 否 | `3` | 本轮变化提醒阈值（%，配合下方窗口） |
| `DAY_ALERT_PERCENT` | 否 | `5` | 24H 变化提醒阈值（%，边沿触发） |
| `DAY_REARM_PERCENT` | 否 | `阈值-1` | 24H 回滞阈值，回落到此值内才允许再次触发 |
| `ALERT_COOLDOWN_MIN` | 否 | `30` | 同项目提醒冷却（分钟） |
| `COOLDOWN_SCOPE` | 否 | `project` | 冷却作用域：`project`=同项目共用；`type`=本轮/24H 各自独立 |
| `POLL_LOOKBACK_SEC` | 否 | `60` | 本轮变化回看窗口（秒），0=对比上一次轮询 |
| `TELEGRAM_TOPIC_ID` | 否 | — | 群组话题(forum topic) id，作为默认订阅的话题 |
| `TELEGRAM_ADMIN_USER_IDS` | 否 | — | 有权改阈值/订阅/暂停的用户 id（逗号分隔）；留空=开放 |
| `DATA_FILE` | 否 | `./data.json` | 持久化文件路径，指向 Railway Volume 可跨重新部署保留 |
| `UPCOMING_ENABLED` | 否 | `true` | 是否监控即将上市（pre_launch）项目 |
| `UPCOMING_INTERVAL_SEC` | 否 | `300` | 轮询 pre_launch 列表的间隔（秒，最小 60）；远期新项目只公告一次 |
| `LAUNCH_SOON_MIN` | 否 | `30` | 开盘前这么多分钟内才开始反复提醒 |
| `LAUNCH_ALERT_INTERVAL_MIN` | 否 | `5` | 临开盘窗口内的提醒间隔（分钟） |
| `REFRESH_INTERVAL_MIN` | 否 | `10` | 自动同步监控列表的间隔（分钟），0=关闭 |
| `DIGEST_INTERVAL_MIN` | 否 | `60` | 全量播报间隔（分钟），0=关闭 |
| `TRADING_CONFIG_ID` | 否 | `1` | assets-list / arena 的交易配置 id |
| `ASPECTA_COOKIE` | 否 | — | 若接口返回 401/403，填登录后的 Cookie |
| `PORT` | 否 | `3000` | HTTP 端口（Railway 自动注入） |

> 零运行时依赖：健康检查用 Node 内置 `http`，不再依赖 Express。运行 `npm test` 执行测试。
>
> **持久化**：订阅与运行时设置会写入 `DATA_FILE`，重启后自动恢复。Railway 默认文件系统在重新部署时会清空，需要跨部署保留请挂载 Volume 并把 `DATA_FILE` 指向其路径（如 `/data/data.json`）。
>
> **权限**：设置 `TELEGRAM_ADMIN_USER_IDS` 后，只有这些用户能执行订阅/暂停/改阈值等写类命令；查询类命令对所有人开放。留空则全部开放。

## 拉进群组 / 发到指定话题

机器人本身没有“激活”开关：只要进程在跑、有订阅目标，它就会监听命令并推送提醒。直接用 **`/subscribe`** 绑定话题即可，无需配置授权：

1. **拉进群**：在群里「添加成员」搜索机器人用户名加入。
   （若加不进，去 @BotFather → `/setjoingroups` → Enable 允许机器人入群。）
2. **订阅话题**（群需开启「话题/Topics」功能）：进入目标话题，发 **`/subscribe`**，机器人记录当前 `message_thread_id`，之后所有提醒都会带这个参数发到该话题。可在多个话题分别 `/subscribe`，提醒会同时发到所有订阅话题。
   - `/unsubscribe` 取消当前话题；`/subs` 查看全部订阅目标。

> 命令对所有人开放（无授权限制），机器人会响应它所在的任意群/私聊。`TELEGRAM_CHAT_ID` 不再用于授权，仅作为重启后自动恢复的默认订阅（见下方持久化）。

关于消息为何只发到第一个/General 话题：Telegram 要求发送时带 `message_thread_id` 才会进指定话题，只传 `chat_id` 会落到 General。本机器人已在所有发送（提醒、命令回复、按钮）中带上该参数。

补充说明：

- 机器人在群里默认开启隐私模式，只能收到以 `/` 开头的命令，这对本机器人足够；多机器人同群时请用 `/now@你的机器人名`。
- 在某话题里发命令或点按钮，回复会自动留在同一话题。
- 若话题限制了发言权限，建议把机器人设为管理员。
- **持久化**：`/subscribe` 的订阅存在内存里，重启/重新部署会丢失。需要长期固定的目标，请用环境变量 `TELEGRAM_CHAT_ID`（+ 可选 `TELEGRAM_TOPIC_ID`）作为默认订阅——它在每次启动时自动恢复。

## 盯盘前异动：阈值怎么设

- **突发异动**（秒/分钟级拉砸）靠「本轮变化」`POLL_ALERT_PERCENT`：间隔短、阈值低更灵敏。
- **慢涨累积的异动**：把 `POLL_LOOKBACK_SEC` 设成 `300`（或用 `/set_lookback 300`），本轮变化就改为对比“近 5 分钟”的价格，而不只是上一次轮询。
- **冷却** `ALERT_COOLDOWN_MIN` 默认 30 分钟对盯盘偏长，异动持续时会漏；盯盘时用 `/set_cooldown 5` 调短。

推荐两套预设：

| 场景 | interval | poll | lookback | day | cooldown |
| --- | --- | --- | --- | --- | --- |
| 灵敏（抓小异动） | 30s | 0.5% | 300s | 3% | 5min |
| 均衡（抓明显异动） | 60s | 2% | 0 | 5% | 15min |

## Telegram 命令

支持两种菜单：输入框旁的原生命令菜单（启动时通过 `setMyCommands` 自动注册），以及 `/menu` 弹出的点击式按钮菜单（inline keyboard，点按钮即触发对应功能）。

| 命令 | 说明 |
| --- | --- |
| `/menu` | 打开点击式功能菜单 |
| `/id` | 查看当前 chat_id / topic_id |
| `/now` | 立即查询全部项目 |
| `/top` | 查看 24H 涨跌排行 |
| `/all` | 全部市场（已上市按近期成交额排序 + 即将上市） |
| `/upcoming` | 查看即将上市（pre-launch）项目 |
| `/refresh` | 刷新监控列表（同步当前活跃项目） |
| `/detail GAEA` | 查看单个项目 |
| `/subscribe` | 把提醒订阅到当前话题 |
| `/unsubscribe` | 取消当前话题的订阅 |
| `/subs` | 查看所有订阅目标 |
| `/pause` / `/resume` | 暂停 / 恢复自动提醒 |
| `/set_interval 60` | 设置查询间隔（秒） |
| `/set_poll 1` | 设置本轮变化阈值（%） |
| `/set_day 5` | 设置 24H 变化阈值（%） |
| `/set_rearm 4` | 设置 24H 回滞阈值（%） |
| `/set_cooldown 5` | 设置提醒冷却（分钟） |
| `/set_lookback 300` | 设置本轮变化回看窗口（秒），0=对比上一次轮询 |
| `/status` | 查看当前配置 |
| `/settings` | 打开设置卡片（按钮调整阈值/间隔等） |
| `/help` | 查看命令列表 |

> 运行时通过命令修改的设置（含 `/subscribe` 订阅）会写入 `DATA_FILE` 持久化，重启后自动恢复。

## 本地运行

```bash
cp .env.example .env   # 填入 Token 和 chat_id
# 用任意方式注入环境变量后：
npm install
npm start
```

健康检查：`GET http://localhost:3000/health`

## 接口说明

请求 `https://trade.aspecta.ai/api/hermes/trading/k-line`，参数：

- `project_address`：项目名用英文逗号拼接
- `offset`：与项目数量等长，每个为 `24`
- `window_type`：与项目数量等长，每个为 `1h`

返回每个项目一个对象，内含 `k_line` 数组；`open_price` / `close_price` / `high_price` / `low_price` 为 18 位精度，需除以 `1e18` 还原为价格。
