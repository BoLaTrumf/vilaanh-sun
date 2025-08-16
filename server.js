const Fastify = require("fastify");
const cors = require("@fastify/cors");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJ0cmFudGhhbmhiaW5ocG0iLCJib3QiOjAsImlzTWVyY2hhbnQiOmZhbHNlLCJ2ZXJpZmllZEJhbmtBY2NvdW50Ijp0cnVlLCJwbGF5RXZlbnRMb2JieSI6ZmFsc2UsImN1c3RvbWVySWQiOjI0MzE2NTExMSwiYWZmSWQiOiJkZWZhdWx0IiwiYmFubmVkIjpmYWxzZSwiYnJhbmQiOiJzdW4ud2luIiwidGltZXN0YW1wIjoxNzU1MzUzNTQ2NjI1LCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjEyNS4yMzUuMjM5Ljc1IiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vaW1hZ2VzLnN3aW5zaG9wLm5ldC9pbWFnZXMvYXZhdGFyL2F2YXRhcl8wMi5wbmciLCJwbGF0Zm9ybUlkIjoyLCJ1c2VySWQiOiI1ZTIyMjYwYS05MTA5LTQ2ZjgtOWUxNS05NWYxOGYyYzFiNGYiLCJyZWdUaW1lIjoxNzQ2MDg1Nzg0NDU3LCJwaG9uZSI6IiIsImRlcG9zaXQiOnRydWUsInVzZXJuYW1lIjoiU0NfdGhhbmhiaW5oc2IifQ.SZuZ5reoMaHhqwEL1oYtCnemXnL7aNtcJSmbjiKzJFU";

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

// Lấy pattern 13 phiên gần nhất
function getLast13Pattern(history) {
  if (history.length < 13) return "Không đủ 13 phiên";
  return history.slice(0, 13).map(item => getTX(item.d1, item.d2, item.d3)).join('');
}

// Dự đoán đơn giản
function simplePrediction(pattern) {
  if (pattern.length < 13) return "Không đủ dữ liệu";
  
  const last3 = pattern.slice(0, 3);
  const taiCount = (last3.match(/T/g) || []).length;
  const xiuCount = 3 - taiCount;
  
  // Nếu 2 trong 3 phiên gần nhất là Tài -> Dự đoán Xỉu và ngược lại
  return taiCount >= 2 ? "Xỉu" : "Tài";
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
          ipAddress: "125.235.239.75",
          wsToken: TOKEN,
          userId: "5e22260a-9109-46f8-9e15-95f18f2c1b4f",
          username: "SC_thanhbinhsb",
          timestamp: 1755353546625,
          refreshToken: "043f339a309f4f3bbc3e4473232b2b73.cd48f2f637bb498caf35d38375841bde",
        }),
        signature: "88ED4326A0B2C3DD7C3D2954B06242EDEED45BF59A4D499B02F3CB02F160D05D06275F2852497BA975358174C7EDA74F8F25D0E6204BFA36062AF9B09313A8E67C0BC3DB790A54383785F61D8969E48A0360914ED7F2270246F121EA16A6705042296E45355EB29AE326D6C19A8ABC629BC746036DF683DF836AE2C560107B6B",
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
  const pattern = getLast13Pattern(valid);

  return {
    id: "binhtool90",
    Phien: current.sid,
    Xuc_xac_1: current.d1,
    Xuc_xac_2: current.d2,
    Xuc_xac_3: current.d3,
    Tong: sum,
    Ket_qua: ket_qua,
    du_doan: simplePrediction(pattern),
    Pattern: pattern
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
