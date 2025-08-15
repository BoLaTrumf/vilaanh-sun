const Fastify = require("fastify");
const cors = require("@fastify/cors");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJ0cmFudGhhbmhiaW5ocG0iLCJib3QiOjAsImlzTWVyY2hhbnQiOmZhbHNlLCJ2ZXJpZmllZEJhbmtBY2NvdW50Ijp0cnVlLCJwbGF5RXZlbnRMb2JieSI6ZmFsc2UsImN1c3RvbWVySWQiOjI0MzE2NTExMSwiYWZmSWQiOiJkZWZhdWx0IiwiYmFubmVkIjpmYWxzZSwiYnJhbmQiOiJzdW4ud2luIiwidGltZXN0YW1wIjoxNzU1MjQ3MDUxMzY4LCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjEyNS4yMzUuMjM5LjIxNyIsIm11dGUiOmZhbHNlLCJhdmF0YXIiOiJodHRwczovL2ltYWdlcy5zd2luc2hvcC5uZXQvaW1hZ2VzL2F2YXRhci9hdmF0YXJfMDIucG5nIiwicGxhdGZvcm1JZCI6MiwidXNlcklkIjoiNWUyMjI2MGEtOTEwOS00NmY4LTllMTUtOTVmMThmMmMxYjRmIiwicmVnVGltZSI6MTc0NjA4NTc4NDQ1NywicGhvbmUiOiIiLCJkZXBvc2l0Ijp0cnVlLCJ1c2VybmFtZSI6IlNDX3RoYW5oYmluaHNiIn0.ntupp_Q3aQ_ZIyJQOiEUMb74g6bK6RIJrJouq21eBLs";

const fastify = Fastify({ logger: false });
const PORT = process.env.PORT || 3001;
const HISTORY_FILE = path.join(__dirname, 'taixiu_history.json');

let rikResults = [];
let rikCurrentSession = null;
let rikWS = null;
let rikIntervalCmd = null;

// Load & save history
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      rikResults = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`📚 Loaded ${rikResults.length} history records`);
    }
  } catch (err) {
    console.error('Error loading history:', err);
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(rikResults), 'utf8');
  } catch (err) {
    console.error('Error saving history:', err);
  }
}

// Decode binary messages from WS
function decodeBinaryMessage(buffer) {
  try {
    const str = buffer.toString();
    if (str.startsWith("[")) return JSON.parse(str);
    let position = 0, result = [];
    while (position < buffer.length) {
      const type = buffer.readUInt8(position++);
      if (type === 1) {
        const len = buffer.readUInt16BE(position); position += 2;
        result.push(buffer.toString('utf8', position, position + len));
        position += len;
      } else if (type === 2) {
        result.push(buffer.readInt32BE(position)); position += 4;
      } else if (type === 3 || type === 4) {
        const len = buffer.readUInt16BE(position); position += 2;
        result.push(JSON.parse(buffer.toString('utf8', position, position + len)));
        position += len;
      } else {
        console.warn("Unknown binary type:", type); break;
      }
    }
    return result.length === 1 ? result[0] : result;
  } catch (e) {
    console.error("Binary decode error:", e);
    return null;
  }
}

// Tài/Xỉu
function getTX(d1, d2, d3) {
  return d1 + d2 + d3 >= 11 ? "T" : "X";
}

// Pattern analysis
function analyzePatterns(history) {
  if (history.length < 5) return null;
  const patternHistory = history.slice(0, 30).map(item => getTX(item.d1, item.d2, item.d3)).join('');
  const knownPatterns = {
    'ttxtttttxtxtxttxtxtxtxtxtxxttxt': 'Pattern thường xuất hiện sau chuỗi Tài-Tài-Xỉu-Tài...',
    'ttttxxxx': '4 Tài liên tiếp thường đi kèm 4 Xỉu',
    'xtxtxtxt': 'Xen kẽ Tài Xỉu ổn định',
    'ttxxttxxttxx': 'Chu kỳ 2 Tài 2 Xỉu'
  };
  for (const [pattern, description] of Object.entries(knownPatterns)) {
    if (patternHistory.includes(pattern)) {
      return {
        pattern, description,
        confidence: Math.floor(Math.random() * 20) + 80
      };
    }
  }
  return null;
}

// Dự đoán phiên tiếp theo
function predictNext(history) {
  if (history.length < 4) return history.at(-1) || "Tài";
  const last = history.at(-1);

  if (history.slice(-4).every(k => k === last)) return last;

  if (history.length >= 4 &&
    history.at(-1) === history.at(-2) &&
    history.at(-3) === history.at(-4) &&
    history.at(-1) !== history.at(-3)) {
    return last === "Tài" ? "Xỉu" : "Tài";
  }

  const last4 = history.slice(-4);
  if (last4[0] !== last4[1] && last4[1] === last4[2] && last4[2] !== last4[3]) {
    return last === "Tài" ? "Xỉu" : "Tài";
  }

  const pattern = history.slice(-6, -3).toString();
  const latest = history.slice(-3).toString();
  if (pattern === latest) return history.at(-1);

  if (new Set(history.slice(-3)).size === 3) {
    return Math.random() < 0.5 ? "Tài" : "Xỉu";
  }

  const count = history.reduce((acc, val) => {
    acc[val] = (acc[val] || 0) + 1;
    return acc;
  }, {});
  return (count["Tài"] || 0) > (count["Xỉu"] || 0) ? "Xỉu" : "Tài";
}

// WebSocket command
function sendRikCmd1005() {
  if (rikWS?.readyState === WebSocket.OPEN) {
    rikWS.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { cmd: 1005 }]));
  }
}

// Kết nối WebSocket SunWin
function connectRikWebSocket() {
  console.log("🔌 Connecting to SunWin WebSocket...");
  rikWS = new WebSocket(`wss://websocket.azhkthg1.net/websocket?token=${TOKEN}`);

  rikWS.on("open", () => {
    const authPayload = [
      1,
      "MiniGame",
      "SC_thanhbinhsb",
      "binhthanhsb",
      {
        info: JSON.stringify({
          ipAddress: "125.235.239.217",
          wsToken: TOKEN,
          userId: "5e22260a-9109-46f8-9e15-95f18f2c1b4f",
          username: "SC_thanhbinhsb",
          timestamp: 1755247051368,
          refreshToken: "043f339a309f4f3bbc3e4473232b2b73.cd48f2f637bb498caf35d38375841bde",
        }),
        signature: "49CC9007069EE20B7764CACED1DA6D9D66B2A503D6AB42EF373F9D86C8BF4FA8D8A8C04ECC3D83E2A6CE3A13E8486C9B785FB92D26D36D68AD59090B56A4FA0494529F3A8D2F8335BB39B791DDAD22169C6CF07A2A90E3BC7957D24312A8DC682936BD058DA708E0DAFF94358DA346E98752EE6573DA463B1C873D1B7B90E392",
        pid: 5,
        subi: true
      }
    ];
    rikWS.send(JSON.stringify(authPayload));
    clearInterval(rikIntervalCmd);
    rikIntervalCmd = setInterval(sendRikCmd1005, 5000);
  });

  rikWS.on("message", (data) => {
    try {
      const json = typeof data === 'string' ? JSON.parse(data) : decodeBinaryMessage(data);
      if (!json) return;

      if (Array.isArray(json) && json[3]?.res?.d1) {
        const res = json[3].res;
        if (!rikCurrentSession || res.sid > rikCurrentSession) {
          rikCurrentSession = res.sid;
          rikResults.unshift({ sid: res.sid, d1: res.d1, d2: res.d2, d3: res.d3, timestamp: Date.now() });
          if (rikResults.length > 100) rikResults.pop();
          saveHistory();
          console.log(`📥 Phiên mới ${res.sid} → ${getTX(res.d1, res.d2, res.d3)}`);
          setTimeout(() => { rikWS?.close(); connectRikWebSocket(); }, 1000);
        }
      } else if (Array.isArray(json) && json[1]?.htr) {
        rikResults = json[1].htr.map(i => ({
          sid: i.sid, d1: i.d1, d2: i.d2, d3: i.d3, timestamp: Date.now()
        })).sort((a, b) => b.sid - a.sid).slice(0, 100);
        saveHistory();
        console.log("📦 Đã tải lịch sử các phiên gần nhất.");
      }
    } catch (e) {
      console.error("❌ Parse error:", e.message);
    }
  });

  rikWS.on("close", () => {
    console.log("🔌 WebSocket disconnected. Reconnecting...");
    setTimeout(connectRikWebSocket, 5000);
  });

  rikWS.on("error", (err) => {
    console.error("🔌 WebSocket error:", err.message);
    rikWS.close();
  });
}

// Load history & connect WS
loadHistory();
connectRikWebSocket();
fastify.register(cors);

// API SunWin
fastify.get("/api/taixiu/sunwin", async () => {
  const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
  if (!valid.length) return { message: "Không có dữ liệu." };

  const current = valid[0];
  const sum = current.d1 + current.d2 + current.d3;
  const ket_qua = sum >= 11 ? "Tài" : "Xỉu";

  const recentTX = valid.map(r => getTX(r.d1, r.d2, r.d3)).slice(0, 30);
  const predText = predictNext(recentTX);
  const patternAnalysis = analyzePatterns(valid);

  return {
    id: "binhtool90",
    Phien: current.sid,
    Xuc_xac_1: current.d1,
    Xuc_xac_2: current.d2,
    Xuc_xac_3: current.d3,
    Tong: sum,
    Ket_qua: ket_qua,
    Pattern: patternAnalysis?.pattern || "Không phát hiện mẫu cụ thể",
    Du_doan: predText === "T" || predText === "Tài" ? "Tài" : "Xỉu"
  };
});

// API lịch sử
fastify.get("/api/taixiu/history", async () => {
  const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
  if (!valid.length) return { message: "Không có dữ liệu lịch sử." };

  return valid.map(i => ({
    Phien: i.sid,
    Xuc_xac_1: i.d1,
    Xuc_xac_2: i.d2,
    Xuc_xac_3: i.d3,
    Tong: i.d1 + i.d2 + i.d3,
    Ket_qua: getTX(i.d1, i.d2, i.d3) === "T" ? "Tài" : "Xỉu"
  }));
});

// Start server
const start = async () => {
  try {
    const address = await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`🚀 API chạy tại ${address}`);
  } catch (err) {
    console.error("❌ Server error:", err);
    process.exit(1);
  }
};

start();
