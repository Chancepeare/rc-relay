/**
 * 中继服务器自测：模拟被控端与控制端，验证房间配对、文本转发、二进制视频帧转发。
 * 用法：先启动服务器（UDP_ENABLED=0 PORT=8899 node server.js），再 node test-relay.js 8899
 */
const WebSocket = require('ws');

const port = Number(process.argv[2] || 8899);
const url = `ws://127.0.0.1:${port}`;
const room = 'aabbccddeeff00112233';
const results = [];
let hostPeers = null;
let viewerPeers = null;
let gotText = false;
let gotBinary = false;

function log(ok, msg) {
  results.push({ ok, msg });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
}

const host = new WebSocket(url);
const viewer = new WebSocket(url);

host.on('open', () => host.send(JSON.stringify({ t: 'hello', room })));
viewer.on('open', () => viewer.send(JSON.stringify({ t: 'hello', room })));

host.on('message', (data, isBinary) => {
  if (isBinary) return;
  const text = data.toString();
  if (text.startsWith('SYS ')) {
    const sys = JSON.parse(text.slice(4));
    if (sys.peers !== undefined) hostPeers = Math.max(hostPeers || 0, sys.peers);
    return;
  }
  if (text === 'ping-from-viewer') {
    gotText = true;
    log(true, '控制端文本指令到达被控端');
  }
});

viewer.on('message', (data, isBinary) => {
  if (isBinary) {
    if (Buffer.isBuffer(data) && data.length === 16 && data[0] === 0x01) {
      gotBinary = true;
      log(true, `被控端二进制视频帧到达控制端（${data.length} 字节）`);
    }
    return;
  }
  const text = data.toString();
  if (text.startsWith('SYS ')) {
    const sys = JSON.parse(text.slice(4));
    if (sys.peers !== undefined) viewerPeers = Math.max(viewerPeers || 0, sys.peers);
  }
});

setTimeout(() => {
  log(hostPeers === 2, `被控端看到房间人数 = ${hostPeers}`);
  log(viewerPeers === 2, `控制端看到房间人数 = ${viewerPeers}`);

  // 控制端 -> 被控端：文本
  viewer.send('ping-from-viewer');
  // 被控端 -> 控制端：二进制帧
  const frame = Buffer.alloc(16, 7);
  frame[0] = 0x01;
  host.send(frame, { binary: true });

  setTimeout(() => {
    log(gotText, '文本转发正常');
    log(gotBinary, '二进制转发正常');
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed === 0 ? '\n全部通过 ✔' : `\n${failed} 项失败 ✘`);
    process.exit(failed === 0 ? 0 : 1);
  }, 500);
}, 600);
