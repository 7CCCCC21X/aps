# Aspecta Telegram Tracker

一个跑在 Railway（或任意 Node 环境）上的 Telegram 机器人：定时请求 Aspecta K 线接口，解析最新价与涨跌幅，达到阈值就通过 Telegram Bot API 推送提醒。

由后端服务请求接口，绕过浏览器 CORS 限制。

## 功能

- 定时（默认 60s）请求 Aspecta `k-line` 接口，解析 18 个固定项目
- 计算 **本轮变化**（两次查询之间）、**1H 变化**、**24H 变化**
- 本轮波动超过 `POLL_ALERT_PERCENT`、或 24H 涨跌超过 `DAY_ALERT_PERCENT` 时推送提醒
- 同项目同类型提醒带冷却时间，避免刷屏
- Telegram 命令交互：查询、排行、暂停/恢复、运行时改阈值
- Express `/health` 接口，供 Railway 健康检查与保活

## 部署到 Railway

1. 把本仓库连接到 Railway，新建一个服务（Node）。
2. 在 **Variables** 里设置环境变量（见下表，不要写进代码）。
3. Railway 会自动执行 `npm install` 并 `npm start`。
4. 部署成功后，在 Telegram 里给机器人发 `/id` 获取你的 `chat_id`，填回 `TELEGRAM_CHAT_ID` 并重新部署。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | — | 找 @BotFather 创建机器人得到的 Token |
| `TELEGRAM_CHAT_ID` | 是 | — | 接收提醒的 chat_id（用 `/id` 获取） |
| `POLL_INTERVAL_SEC` | 否 | `60` | 查询间隔（秒），最小 10 |
| `POLL_ALERT_PERCENT` | 否 | `1` | 本轮变化提醒阈值（%） |
| `DAY_ALERT_PERCENT` | 否 | `5` | 24H 变化提醒阈值（%） |
| `ALERT_COOLDOWN_MIN` | 否 | `30` | 同项目同类型提醒冷却（分钟） |
| `TELEGRAM_TOPIC_ID` | 否 | — | 群组话题(forum topic) id，设置后提醒只发到该话题 |
| `ASPECTA_COOKIE` | 否 | — | 若接口返回 401/403，填登录后的 Cookie |
| `PORT` | 否 | `3000` | HTTP 端口（Railway 自动注入） |

## 拉进群组 / 发到指定话题

机器人本身没有“激活”开关：只要进程在跑、`TELEGRAM_CHAT_ID` 配对，它就会监听命令并推送提醒。把它用到群里只需三步：

1. **拉进群**：在群里「添加成员」搜索机器人用户名加入。
   （若加不进，去 @BotFather → `/setjoingroups` → Enable 允许机器人入群。）
2. **拿群 ID**：在群里发 `/id`，机器人会回复 `Chat ID`（群是负数，超级群形如 `-100…`）。把它填到 `TELEGRAM_CHAT_ID` 并重新部署。
3. **发到指定话题**（群需开启「话题/Topics」功能）：进入目标话题，发 `/id`，机器人会额外回复 `Topic ID`。把它填到 `TELEGRAM_TOPIC_ID` 并重新部署，自动提醒就只发到该话题。

补充说明：

- 机器人在群里默认开启隐私模式，只能收到以 `/` 开头的命令，这对本机器人足够；多机器人同群时请用 `/now@你的机器人名`。
- 在某个话题里发命令，机器人的回复会自动留在同一话题；自动提醒则按 `TELEGRAM_TOPIC_ID` 发送（未设置则发到群「General」）。
- 不设 `TELEGRAM_TOPIC_ID` 也能正常在群里推送，只是不绑定具体话题。

## Telegram 命令

支持两种菜单：输入框旁的原生命令菜单（启动时通过 `setMyCommands` 自动注册），以及 `/menu` 弹出的点击式按钮菜单（inline keyboard，点按钮即触发对应功能）。

| 命令 | 说明 |
| --- | --- |
| `/menu` | 打开点击式功能菜单 |
| `/id` | 查看当前 chat_id |
| `/now` | 立即查询全部项目 |
| `/top` | 查看 24H 涨跌排行 |
| `/detail GAEA` | 查看单个项目 |
| `/pause` / `/resume` | 暂停 / 恢复自动提醒 |
| `/set_interval 60` | 设置查询间隔（秒） |
| `/set_poll 1` | 设置本轮变化阈值（%） |
| `/set_day 5` | 设置 24H 变化阈值（%） |
| `/status` | 查看当前配置 |
| `/help` | 查看命令列表 |

> 运行时通过命令修改的设置在进程重启后会恢复为环境变量的值。

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
