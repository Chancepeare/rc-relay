/**
 * 远程协助中继服务器
 *
 * 两种部署场景：
 *  1) 自建服务器 / 内网（默认）：WebSocket 8787/TCP 信令 + UDP 8788 视频；
 *  2) 免费 PaaS 托管（如 Render / Railway）：只占用一个 HTTP 端口（$PORT），
 *     信令与视频都走 WebSocket(443/TLS)，不绑定 UDP。启动方式：
 *        UDP_ENABLED=0 PORT=8080 node server.js
 *
 * 服务器始终只做「房间内转发」，所有负载是端到端密文。
 */
const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');

const WS_PORT = Number(process.env.PORT || process.env.WS_PORT || 8787);
const UDP_PORT = Number(process.env.UDP_PORT || 8788);
const UDP_ENABLED = process.env.UDP_ENABLED !== '0';
const SYS = 'SYS ';

/** roomId -> Set<Client> */
const rooms = new Map();
let nextId = 1;

/** ---- HTTP + WebSocket ---- */

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('RemoteCtrl relay OK\n');
});

const wss = new WebSocket.Server({ server, maxPayload: 8 * 1024 * 1024 });

wss.on('connection', (socket, req) => {
  const client = { id: 'c' + nextId++, room: null, ws: socket };
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  console.log(`[ws] connect ${client.id} from ${req.socket.remoteAddress}`);

  socket.on('message', (data, isBinary) => {
    if (!client.room) {
      // 首条消息必须是明文 {"t":"hello","room":"..."}
      let hello = null;
      try { hello = JSON.parse(data.toString('utf8')); } catch (e) { hello = null; }
      if (hello && hello.t === 'hello' && typeof hello.room === 'string') {
        joinRoom(client, hello.room);
      } else {
        socket.close(1008, 'no room');
      }
      return;
    }

    for (const peer of rooms.get(client.room) || []) {
      if (peer !== client && peer.ws.readyState === WebSocket.OPEN) {
        // 注意：文本帧必须回传字符串，传 Buffer 会被 ws 当作二进制帧，
        // 客户端就拿不到信令了（只能看到视频帧）。
        if (isBinary) peer.ws.send(data, { binary: true });
        else peer.ws.send(data.toString('utf8'));
      }
    }
  });

  socket.on('close', () => leaveRoom(client));
  socket.on('error', () => leaveRoom(client));
});

function joinRoom(client, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  const set = rooms.get(room);
  if (set.size >= 2) {
    client.ws.close(1008, 'room full');
    return;
  }
  client.room = room;
  set.add(client);
  client.ws.send(SYS + JSON.stringify({ id: client.id, peers: set.size }));
  broadcastPeers(room);
  console.log(`[ws] ${client.id} joined room ${room} (${set.size}/2)`);
}

function leaveRoom(client) {
  if (!client.room) return;
  const set = rooms.get(client.room);
  if (set) {
    set.delete(client);
    broadcastPeers(client.room);
    if (set.size === 0) rooms.delete(client.room);
  }
  console.log(`[ws] ${client.id} left room ${client.room}`);
  client.room = null;
}

function broadcastPeers(room) {
  const set = rooms.get(room);
  if (!set) return;
  for (const peer of set) {
    const others = Array.from(set).filter((c) => c !== peer);
    const othersReady = others.filter((c) => c.ws.readyState === WebSocket.OPEN);
    peer.ws.send(SYS + JSON.stringify({
      id: peer.id,
      peers: othersReady.length + 1,
      udpPeerReady: UDP_ENABLED && others.some((c) => udpEndpoints.has(c.id)),
    }));
  }
}

server.listen(WS_PORT, () => {
  console.log(`[ws] relay listening on ${WS_PORT} (udp ${UDP_ENABLED ? 'on:' + UDP_PORT : 'disabled'})`);
});

/** ---- UDP 视频转发（免费托管模式不需要） ---- */

/** clientId -> { address, port, seenAt } */
const udpEndpoints = new Map();
/** "address:port" -> clientId */
const addrIndex = new Map();
/** room -> Set<clientId> */
const roomMembers = new Map();

const keyOf = (a, p) => `${a}:${p}`;

if (UDP_ENABLED) {
  const udp = dgram.createSocket('udp4');

  udp.on('message', (msg, rinfo) => {
    const senderKey = keyOf(rinfo.address, rinfo.port);

    // 注册/保活包："RCUDP:<room>:<clientId>"
    if (msg.length < 200 && msg[0] === 0x52 /* 'R' */ && msg.toString('utf8').startsWith('RCUDP:')) {
      const [, room, id] = msg.toString('utf8').split(':');
      const isNew = !udpEndpoints.has(id) || udpEndpoints.get(id).port !== rinfo.port;
      udpEndpoints.set(id, { address: rinfo.address, port: rinfo.port, seenAt: Date.now() });
      addrIndex.set(senderKey, id);
      if (!roomMembers.has(room)) roomMembers.set(room, new Set());
      roomMembers.get(room).add(id);
      if (isNew) broadcastPeers(room);
      return;
    }

    // 视频切片包：转发给同房间的另一端
    const selfId = addrIndex.get(senderKey);
    if (!selfId) return;
    for (const [room, ids] of roomMembers) {
      if (!ids.has(selfId)) continue;
      for (const id of ids) {
        if (id === selfId) continue;
        const ep = udpEndpoints.get(id);
        if (ep) udp.send(msg, 0, msg.length, ep.port, ep.address, () => {});
      }
      break;
    }
  });

  udp.on('error', (err) => console.error('[udp] error', err));

  udp.bind(UDP_PORT, () => console.log(`[udp] relay listening on ${UDP_PORT}`));
}

// 心跳，清理死连接
setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
  const now = Date.now();
  for (const [id, ep] of udpEndpoints) {
    if (now - (ep.seenAt || now) > 15000) {
      udpEndpoints.delete(id);
      addrIndex.delete(keyOf(ep.address, ep.port));
    }
  }
}, 10000);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
