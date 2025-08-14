const Fastify = require("fastify");
const cors = require("@fastify/cors");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJ0cnVtbW1tbSIsImJvdCI6MCwiaXNNZXJjaGFudCI6ZmFsc2UsInZlcmlmaWVkQmFua0FjY291bnQiOmZhbHNlLCJwbGF5RXZlbnRMb2JieSI6ZmFsc2UsImN1c3RvbWVySWQiOjMxMTAzNTM4NCwiYWZmSWQiOiJHRU1XSU4iLCJiYW5uZWQiOmZhbHNlLCJicmFuZCI6ImdlbSIsInRpbWVzdGFtcCI6MTc1NTA2NDc3MjI4MywibG9ja0dhbWVzIjpbXSwiYW1vdW50IjowLCJsb2NrQ2hhdCI6ZmFsc2UsInBob25lVmVyaWZpZWQiOmZhbHNlLCJpcEFkZHJlc3MiOiIyMDAxOmVlMDo1MTQ4OmZlNDA6NTFjYjoxMmRiOjRlMTA6OTU0IiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vaW1hZ2VzLnN3aW5zaG9wLm5ldC9pbWFnZXMvYXZhdGFyL2F2YXRhcl8xNi5wbmciLCJwbGF0Zm9ybUlkIjoxMCwidXNlcklkIjoiZWM4OTQ5MmMtNTYyNy00ZWNiLTgwMjItMDliNWFmYzMxZTBkIiwicmVnVGltZSI6MTc1NDI3MDA4NDU5OCwicGhvbmUiOiIiLCJkZXBvc2l0IjpmYWxzZSwidXNlcm5hbWUiOiJHTV9uZ3V5ZW52YW50aW5oMTMzIn0.4Qn3VvX7TjX0gS7x4K6p5yT2lJjC2wL9u-zL9yK9s0E";
const REFRESH_TOKEN = "a215a90ef4b34d1bbbafd185d33f6c64.6c896b010fd341c89e645661378867c7";
const USER_ID = "6fe31b15-f6a5-4552-9b52-6f57fe689664";
const USERNAME = "GM_binhlaanh";
const IP_ADDRESS = "125.235.239.217";

const fastify = Fastify({ logger: false });
const PORT = process.env.PORT || 3001;
const HISTORY_FILE = path.join(__dirname, 'taixiu_history.json');

let rikResults = [];
let rikCurrentSession = null;
let rikWS = null;
let rikIntervalCmd = null;
let wsToken = TOKEN;

async function refreshAuthToken() {
  console.log("🔄 Refreshing WebSocket token...");
  try {
    const response = await fetch('https://api.gmwin.io/auth/refresh_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken: REFRESH_TOKEN }),
    });

    if (response.ok) {
      const data = await response.json();
      wsToken = data.token;
      console.log("✅ Token refreshed successfully.");
      return true;
    } else {
      console.error("❌ Failed to refresh token:", response.statusText);
      return false;
    }
  } catch (err) {
    console.error("❌ Error during token refresh:", err);
    return false;
  }
}

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

function getTX(d1, d2, d3) {
  return d1 + d2 + d3 >= 11 ? "T" : "X";
}

function sendRikCmd1005() {
  if (rikWS?.readyState === WebSocket.OPEN) {
    rikWS.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { cmd: 1005 }]));
  }
}

async function connectRikWebSocket() {
  console.log("🔌 Connecting to SunWin WebSocket...");
  
  if (rikWS) {
    rikWS.close();
  }

  rikWS = new WebSocket(`wss://websocket.gmwin.io/websocket?token=${wsToken}`);

  rikWS.on("open", () => {
    const authPayload = [
      1,
      "MiniGame",
      USERNAME,
      "123321",
      {
        info: JSON.stringify({
          ipAddress: IP_ADDRESS,
          wsToken: wsToken,
          userId: USER_ID,
          username: USERNAME,
          timestamp: Date.now(),
          refreshToken: REFRESH_TOKEN
        }),
        signature: "617E4E646C365151AA57F671D341828773EA99F93B08BF772E259B22070D7C87ED08936397ABA18589A7D963DBE9C13D320395AE0809A8947848B35090AB8CCB134BCD41EA3188C0F3DEFACDE00B31B09631C9D6C61780C0A518B54F725808CA00C9ED2EFDFC8FCDB19D43658BF9464CD9B5FD8092CB4C42579E19B28744E9E1"
      }
    ];
    rikWS.send(JSON.stringify(authPayload));

    sendRikCmd1005();
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

  rikWS.on("close", async () => {
    console.log("🔌 WebSocket disconnected. Attempting to reconnect...");
    // Refresh token before reconnecting
    const success = await refreshAuthToken();
    if (success) {
      setTimeout(connectRikWebSocket, 1000);
    } else {
      console.error("❌ Failed to refresh token. Cannot reconnect.");
    }
  });

  rikWS.on("error", (err) => {
    console.error("🔌 WebSocket error:", err.message);
    rikWS.close();
  });
}

loadHistory();
connectRikWebSocket();
fastify.register(cors);

fastify.get("/api/ditmemaysun", async () => {
  const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
  if (!valid.length) return { message: "Không có dữ liệu." };

  const current = valid[0];
  const sum = current.d1 + current.d2 + current.d3;
  const ket_qua = sum >= 11 ? "Tài" : "Xỉu";

  return {
    Phien: current.sid,
    Xuc_xac_1: current.d1,
    Xuc_xac_2: current.d2,
    Xuc_xac_3: current.d3,
    Tong: sum,
    Ket_qua: ket_qua,
    id: "@mrtinhios",
  };
});

fastify.get("/api/taixiu/history", async () => {
  const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
  if (!valid.length) return { message: "Không có dữ liệu lịch sử." };
  return valid.map(i => ({
    session: i.sid,
    dice: [i.d1, i.d2, i.d3],
    total: i.d1 + i.d2 + i.d3,
    result: getTX(i.d1, i.d2, i.d3) === "T" ? "Tài" : "Xỉu"
  })).map(JSON.stringify).join("\n");
});

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
