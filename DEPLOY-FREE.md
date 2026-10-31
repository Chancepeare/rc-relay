# 免费部署中继服务器（Render）

适用场景：被控端在宿舍（无公网 IP），控制端在外网。免费方案不给 UDP 端口，
所以 **APK 里要勾选「免费托管模式」**，视频改走 wss（WebSocket over TLS）。

## 一、部署

1. 把 `server` 目录推到一个 GitHub 仓库（公开/私有都可以）：
   ```bash
   cd remote-control/server
   git init && git add . && git commit -m "relay"
   git remote add origin https://github.com/<你的账号>/rc-relay.git
   git push -u origin main
   ```

2. 打开 <https://dashboard.render.com> → **New → Web Service** → 连接该仓库。
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: `Free`
   - Environment Variables: `UDP_ENABLED` = `0`

3. 部署完成后会得到地址，例如：
   ```
   https://rc-relay-abcd.onrender.com
   ```

## 二、APK 里怎么填

两端都这样填：

| 字段 | 值 |
| --- | --- |
| 配对密钥 | 两端相同的任意 ≥6 位字符串 |
| 中继服务器地址 | `rc-relay-abcd.onrender.com`（**不要带 https://**） |
| WS 端口 | `443` |
| UDP 端口 | 随便填（托管模式下不使用） |
| ☑ 免费托管模式 | **必须勾选** |

勾选后端口会自动切到 443，UDP 输入框变灰。

## 三、验证

浏览器打开 `https://rc-relay-abcd.onrender.com` 应看到：

```
RemoteCtrl relay OK
```

说明服务已启动。

## 四、注意

- **免费实例会休眠**：15 分钟无人访问会挂起，第一次连接需要等 20~50 秒唤醒，表现为「一直显示等待对方」。等待期间保持 App 打开即可，第二段起就快了。
- 免费实例带宽/CPU 有限，建议把被控端分辨率降到 720p（`HostService.MAX_EDGE = 720`）或把码率系数调小，否则可能卡顿。
- 视频走 TLS 单连接，延迟高于 UDP（约 +50~150ms），日常「帮忙点几下」够用；追求流畅请改用 VPS + UDP 模式。
- 免费额度有每月流量上限，长时间挂着看视频可能触顶。

## 五、自建服务器（保留 UDP，效果更好）

```bash
PORT=8787 UDP_ENABLED=1 UDP_PORT=8788 node server.js
```

云服务器安全组 / 防火墙需同时放行 **TCP 8787** 与 **UDP 8788**，
APK 里不勾「免费托管模式」，端口填 8787 / 8788。
