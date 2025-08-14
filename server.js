const Fastify = require("fastify");
const cors = require("@fastify/cors");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOiAsImNhbGVuZGFyIjpmYWxzZSwiZGlzcGxheU5hbWUiOiJ0cmFudGVyLCJib3QiAsImlzTWVyY2hhbnQiOmZhbHNlLCJ2ZXJzaW9uIjpcnVILJwbGF5RXZlbmRmb2JleSI6ZmFsc2UsImN3RvbWVYwSWQiOi0MzE2NTExMSwiYWZmSWQiOiJkZWxlYXRlIiwifubmVkIjpmYWxzZSwiYmhpQiOJDZ4ud2luZidWIiwioYWIiOjAxMTU0NzE1MyIsbnJ2RmtzIltdLCJlbmQiAsImtxY2hhbnQiOmZhbHNlLCJwcm9ncmVzc2JhcjoiMDE6MDA6NjYgTQ4Mzo5OTM6YzgzZjphNWlxOjU0ZmljLCJtdXRlIjpmYWxzZSwiYXZhdGFyIjoiaHR0cHM6Ly9pbWFnZXMuY29tL2ltYWdlcy9hYmMuanBnIiwibWVnYXphY2FjbyI6ZmFsc2UsImVtYWlsIjoibnVsbCJ9.F39gaj5nrIJ_33V-b0Zxzei4kyB2hi1n1mzSpQm1XvA";

const fastify = Fastify({ logger: false });
const PORT = process.env.PORT || 3001;
const HISTORY_FILE = path.join(__dirname, 'taixiu_history.json');
const MODEL_PREDICTIONS_FILE = path.join(__dirname, 'model_predictions.json');

let rikResults = [];
let rikCurrentSession = null;
let id_phien_chua_co_kq = null;
let rikWS = null;
let rikIntervalCmd = null;
let modelPredictions = {}; // New variable to store model predictions for evaluation

// Hàm load lịch sử và model predictions từ file
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            rikResults = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            console.log(`📚 Đã tải ${rikResults.length} bản ghi lịch sử từ file.`);
        }
        if (fs.existsSync(MODEL_PREDICTIONS_FILE)) {
            modelPredictions = JSON.parse(fs.readFileSync(MODEL_PREDICTIONS_FILE, 'utf8'));
            console.log(`🧠 Đã tải dữ liệu dự đoán của các mô hình.`);
        }
    } catch (err) {
        console.error('Lỗi khi tải lịch sử hoặc dữ liệu dự đoán:', err);
    }
}

// Hàm lưu lịch sử và model predictions vào file
function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(rikResults), 'utf8');
        fs.writeFileSync(MODEL_PREDICTIONS_FILE, JSON.stringify(modelPredictions), 'utf8');
    } catch (err) {
        console.error('Lỗi khi lưu lịch sử hoặc dữ liệu dự đoán:', err);
    }
}

// Hàm giải mã tin nhắn binary
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
                console.warn("Loại binary không xác định:", type); break;
            }
        }
        return result.length === 1 ? result[0] : result;
    } catch (e) {
        console.error("Lỗi giải mã binary:", e);
        return null;
    }
}

// Hàm xác định kết quả Tài/Xỉu
function getTX(d1, d2, d3) {
    return d1 + d2 + d3 >= 11 ? "Tài" : "Xỉu";
}

// ================== THUẬT TOÁN DỰ ĐOÁN MỚI ==================

/**
 * Your new prediction logic, consolidated into a single object for clarity.
 * These functions have been copied directly from your request.
 */
function detectStreakAndBreak(history) {
    if (!history || history.length === 0) return { streak: 0, currentResult: null, breakProb: 0.0 };
    let streak = 1;
    const currentResult = history[history.length - 1].result;
    for (let i = history.length - 2; i >= 0; i--) {
      if (history[i].result === currentResult) {
        streak++;
      } else {
        break;
      }
    }
    const last15 = history.slice(-15);
    if (!last15.length) return { streak, currentResult, breakProb: 0.0 };
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr.result !== last15[idx].result ? 1 : 0), 0);
    const taiCount = last15.filter(r => r.result === 'Tài').length;
    const xiuCount = last15.filter(r => r.result === 'Xỉu').length;
    const imbalance = Math.abs(taiCount - xiuCount) / last15.length;
    let breakProb = 0.0;
  
    // Tăng độ nhạy cho bẻ cầu
    if (streak >= 6) {
      breakProb = Math.min(0.8 + (switches / 15) + imbalance * 0.3, 0.95);
    } else if (streak >= 4) {
      breakProb = Math.min(0.5 + (switches / 12) + imbalance * 0.25, 0.9);
    } else if (streak >= 2 && switches >= 5) {
      breakProb = 0.45; // Nhận diện cầu không ổn định
    } else if (streak === 1 && switches >= 6) {
      breakProb = 0.3; // Tăng xác suất bẻ khi có nhiều chuyển đổi
    }
  
    return { streak, currentResult, breakProb };
}

function evaluateModelPerformance(history, modelName, lookback = 10) {
    if (!modelPredictions[modelName] || history.length < 2) return 1.0;
    lookback = Math.min(lookback, history.length - 1);
    let correctCount = 0;
    for (let i = 0; i < lookback; i++) {
      const pred = modelPredictions[modelName][history[history.length - (i + 2)].sid] || 0;
      const actual = history[history.length - (i + 1)].result;
      if ((pred === 1 && actual === 'Tài') || (pred === 2 && actual === 'Xỉu')) {
        correctCount++;
      }
    }
    const performanceScore = lookback > 0 ? 1.0 + (correctCount - lookback / 2) / (lookback / 2) : 1.0;
    return Math.max(0.0, Math.min(2.0, performanceScore));
}

function smartBridgeBreak(history) {
    if (!history || history.length < 5) return { prediction: 0, breakProb: 0.0, reason: 'Không đủ dữ liệu để theo/bẻ cầu' };

    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    const last20 = history.slice(-20);
    const lastScores = last20.map(h => h.totalScore || 0);
    let breakProbability = breakProb;
    let reason = '';

    const avgScore = lastScores.reduce((sum, score) => sum + score, 0) / (lastScores.length || 1);
    const scoreDeviation = lastScores.reduce((sum, score) => sum + Math.abs(score - avgScore), 0) / (lastScores.length || 1);

    // Phân tích mẫu lặp ngắn (2-3 kết quả) để theo cầu
    const last5 = last20.slice(-5).map(h => h.result);
    const patternCounts = {};
    for (let i = 0; i <= last20.length - 2; i++) {
      const pattern = last20.slice(i, i + 2).map(h => h.result).join(',');
      patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
    }
    const mostCommonPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    const isStablePattern = mostCommonPattern && mostCommonPattern[1] >= 3;

    // Theo cầu thông minh
    if (streak >= 3 && scoreDeviation < 2.0 && !isStablePattern) {
      breakProbability = Math.max(breakProbability - 0.25, 0.1);
      reason = `[Theo Cầu Thông Minh] Chuỗi ${streak} ${currentResult} ổn định, tiếp tục theo cầu`;
    } else if (streak >= 6) {
      breakProbability = Math.min(breakProbability + 0.3, 0.95);
      reason = `[Bẻ Cầu Thông Minh] Chuỗi ${streak} ${currentResult} quá dài, khả năng bẻ cầu cao`;
    } else if (streak >= 3 && scoreDeviation > 3.5) {
      breakProbability = Math.min(breakProbability + 0.25, 0.9);
      reason = `[Bẻ Cầu Thông Minh] Biến động điểm số lớn (${scoreDeviation.toFixed(1)}), khả năng bẻ cầu tăng`;
    } else if (isStablePattern && last5.every(r => r === currentResult)) {
      breakProbability = Math.min(breakProbability + 0.2, 0.85);
      reason = `[Bẻ Cầu Thông Minh] Phát hiện mẫu lặp ${mostCommonPattern[0]}, có khả năng bẻ cầu`;
    } else {
      breakProbability = Math.max(breakProbability - 0.2, 0.1);
      reason = `[Theo Cầu Thông Minh] Không phát hiện mẫu bẻ mạnh, tiếp tục theo cầu`;
    }

    let prediction = breakProbability > 0.5 ? (currentResult === 'Tài' ? 2 : 1) : (currentResult === 'Tài' ? 1 : 2);
    return { prediction, breakProb: breakProbability, reason };
}

function trendAndProb(history) {
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 3) {
      if (breakProb > 0.6) {
        return currentResult === 'Tài' ? 2 : 1;
      }
      return currentResult === 'Tài' ? 1 : 2; // Theo cầu nếu chuỗi ổn định
    }
    const last15 = history.slice(-15);
    if (!last15.length) return 0;
    const weights = last15.map((_, i) => Math.pow(1.3, i));
    const taiWeighted = weights.reduce((sum, w, i) => sum + (last15[i].result === 'Tài' ? w : 0), 0);
    const xiuWeighted = weights.reduce((sum, w, i) => sum + (last15[i].result === 'Xỉu' ? w : 0), 0);
    const totalWeight = taiWeighted + xiuWeighted;
    const last10 = last15.slice(-10);
    const patterns = [];
    if (last10.length >= 4) {
      for (let i = 0; i <= last10.length - 4; i++) {
        patterns.push(last10.slice(i, i + 4).map(h => h.result).join(','));
      }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 3) {
      const pattern = mostCommon[0].split(',');
      return pattern[pattern.length - 1] !== last10[last10.length - 1].result ? 1 : 2;
    } else if (totalWeight > 0 && Math.abs(taiWeighted - xiuWeighted) / totalWeight >= 0.25) {
      return taiWeighted > xiuWeighted ? 1 : 2;
    }
    return last15[last15.length - 1].result === 'Xỉu' ? 1 : 2;
}

function shortPattern(history) {
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 2) {
      if (breakProb > 0.6) {
        return currentResult === 'Tài' ? 2 : 1;
      }
      return currentResult === 'Tài' ? 1 : 2; // Theo cầu ngắn
    }
    const last8 = history.slice(-8);
    if (!last8.length) return 0;
    const patterns = [];
    if (last8.length >= 2) {
      for (let i = 0; i <= last8.length - 2; i++) {
        patterns.push(last8.slice(i, i + 2).map(h => h.result).join(','));
      }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 2) {
      const pattern = mostCommon[0].split(',');
      return pattern[pattern.length - 1] !== last8[last8.length - 1].result ? 1 : 2;
    }
    return last8[last8.length - 1].result === 'Xỉu' ? 1 : 2;
}

function meanDeviation(history) {
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 2) {
      if (breakProb > 0.6) {
        return currentResult === 'Tài' ? 2 : 1;
      }
      return currentResult === 'Tài' ? 1 : 2; // Theo cầu nếu chuỗi ổn định
    }
    const last12 = history.slice(-12);
    if (!last12.length) return 0;
    const taiCount = last12.filter(r => r.result === 'Tài').length;
    const xiuCount = last12.length - taiCount;
    const deviation = Math.abs(taiCount - xiuCount) / last12.length;
    if (deviation < 0.2) {
      return last12[last12.length - 1].result === 'Xỉu' ? 1 : 2;
    }
    return xiuCount > taiCount ? 1 : 2;
}

function recentSwitch(history) {
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 2) {
      if (breakProb > 0.6) {
        return currentResult === 'Tài' ? 2 : 1;
      }
      return currentResult === 'Tài' ? 1 : 2; // Theo cầu nếu chuỗi ổn định
    }
    const last10 = history.slice(-10);
    if (!last10.length) return 0;
    const switches = last10.slice(1).reduce((count, curr, idx) => count + (curr.result !== last10[idx].result ? 1 : 0), 0);
    return switches >= 4 ? (last10[last10.length - 1].result === 'Xỉu' ? 1 : 2) : (last10[last10.length - 1].result === 'Xỉu' ? 1 : 2);
}

function isBadPattern(history) {
    const last15 = history.slice(-15);
    if (!last15.length) return false;
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr.result !== last15[idx].result ? 1 : 0), 0);
    const { streak } = detectStreakAndBreak(history);
    return switches >= 6 || streak >= 7; // Tăng độ nhạy để phát hiện mẫu xấu
}

function aiHtddLogic(history) {
    const recentHistory = history.slice(-5);
    const recentScores = recentHistory.map(h => h.totalScore || 0);
    const taiCount = recentHistory.filter(r => r.result === 'Tài').length;
    const xiuCount = recentHistory.filter(r => r.result === 'Xỉu').length;
    const { streak, currentResult } = detectStreakAndBreak(history);
  
    // Theo cầu thông minh: Theo chuỗi ngắn
    if (streak >= 2 && streak <= 4) {
      return { 
        prediction: currentResult, 
        reason: `[Theo Cầu Thông Minh] Chuỗi ngắn ${streak} ${currentResult}, tiếp tục theo cầu`, 
        source: 'AI HTDD' 
      };
    }
  
    // Bẻ cầu thông minh: Phát hiện mẫu lặp
    if (history.length >= 3) {
      const last3 = history.slice(-3).map(h => h.result);
      if (last3.join(',') === 'Tài,Xỉu,Tài') {
        return { prediction: 'Xỉu', reason: '[Bẻ Cầu Thông Minh] Phát hiện mẫu 1T1X → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
      } else if (last3.join(',') === 'Xỉu,Tài,Xỉu') {
        return { prediction: 'Tài', reason: '[Bẻ Cầu Thông Minh] Phát hiện mẫu 1X1T → tiếp theo nên đánh Tài', source: 'AI HTDD' };
      }
    }
  
    if (history.length >= 4) {
      const last4 = history.slice(-4).map(h => h.result);
      if (last4.join(',') === 'Tài,Tài,Xỉu,Xỉu') {
        return { prediction: 'Tài', reason: '[Theo Cầu Thông Minh] Phát hiện mẫu 2T2X → tiếp theo nên đánh Tài', source: 'AI HTDD' };
      } else if (last4.join(',') === 'Xỉu,Xỉu,Tài,Tài') {
        return { prediction: 'Xỉu', reason: '[Theo Cầu Thông Minh] Phát hiện mẫu 2X2T → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
      }
    }
  
    if (history.length >= 7 && history.slice(-7).every(h => h.result === 'Xỉu')) {
      return { prediction: 'Tài', reason: '[Bẻ Cầu Thông Minh] Chuỗi Xỉu quá dài (7 lần) → dự đoán Tài', source: 'AI HTDD' };
    } else if (history.length >= 7 && history.slice(-7).every(h => h.result === 'Tài')) {
      return { prediction: 'Xỉu', reason: '[Bẻ Cầu Thông Minh] Chuỗi Tài quá dài (7 lần) → dự đoán Xỉu', source: 'AI HTDD' };
    }
  
    const avgScore = recentScores.reduce((sum, score) => sum + score, 0) / (recentScores.length || 1);
    if (avgScore > 11) {
      return { prediction: 'Tài', reason: `[Theo Cầu Thông Minh] Điểm trung bình cao (${avgScore.toFixed(1)}) → dự đoán Tài`, source: 'AI HTDD' };
    } else if (avgScore < 7) {
      return { prediction: 'Xỉu', reason: `[Theo Cầu Thông Minh] Điểm trung bình thấp (${avgScore.toFixed(1)}) → dự đoán Xỉu`, source: 'AI HTDD' };
    }
  
    if (taiCount > xiuCount + 1) {
      return { prediction: 'Xỉu', reason: `[Bẻ Cầu Thông Minh] Tài chiếm đa số (${taiCount}/${recentHistory.length}) → dự đoán Xỉu`, source: 'AI HTDD' };
    } else if (xiuCount > taiCount + 1) {
      return { prediction: 'Tài', reason: `[Bẻ Cầu Thông Minh] Xỉu chiếm đa số (${xiuCount}/${recentHistory.length}) → dự đoán Tài`, source: 'AI HTDD' };
    } else {
      const overallTai = history.filter(h => h.result === 'Tài').length;
      const overallXiu = history.filter(h => h.result === 'Xỉu').length;
      if (overallTai > overallXiu) {
        return { prediction: 'Xỉu', reason: '[Bẻ Cầu Thông Minh] Tổng thể Tài nhiều hơn → dự đoán Xỉu', source: 'AI HTDD' };
      } else {
        return { prediction: 'Tài', reason: '[Theo Cầu Thông Minh] Tổng thể Xỉu nhiều hơn hoặc bằng → dự đoán Tài', source: 'AI HTDD' };
      }
    }
}

function generatePrediction(history) {
    // Nếu không có lịch sử hoặc lịch sử dưới 5 bản ghi, trả về dự đoán ngẫu nhiên
    if (!history || history.length < 5) {
      console.log('Không đủ lịch sử, chọn ngẫu nhiên giữa Tài và Xỉu');
      return {
        prediction: Math.random() < 0.5 ? 'Tài' : 'Xỉu',
        confidence: 50,
        explanation: 'Không đủ dữ liệu để phân tích.'
      };
    }
  
    // Khởi tạo modelPredictions nếu chưa tồn tại
    if (!modelPredictions['trend']) {
      modelPredictions['trend'] = {};
      modelPredictions['short'] = {};
      modelPredictions['mean'] = {};
      modelPredictions['switch'] = {};
      modelPredictions['bridge'] = {};
    }
  
    const currentIndex = history[history.length - 1].sid;
    const { streak } = detectStreakAndBreak(history);
  
    // Gọi các hàm dự đoán từ các mô hình
    const trendPred = trendAndProb(history);
    const shortPred = shortPattern(history);
    const meanPred = meanDeviation(history);
    const switchPred = recentSwitch(history);
    const bridgePred = smartBridgeBreak(history);
    const aiPred = aiHtddLogic(history);
  
    // Lưu dự đoán vào modelPredictions
    modelPredictions['trend'][currentIndex] = trendPred;
    modelPredictions['short'][currentIndex] = shortPred;
    modelPredictions['mean'][currentIndex] = meanPred;
    modelPredictions['switch'][currentIndex] = switchPred;
    modelPredictions['bridge'][currentIndex] = bridgePred.prediction;
  
    // Đánh giá hiệu suất các mô hình
    const modelScores = {
      trend: evaluateModelPerformance(history, 'trend'),
      short: evaluateModelPerformance(history, 'short'),
      mean: evaluateModelPerformance(history, 'mean'),
      switch: evaluateModelPerformance(history, 'switch'),
      bridge: evaluateModelPerformance(history, 'bridge')
    };
  
    // Trọng số động dựa trên độ dài chuỗi và độ ổn định
    const weights = {
      trend: streak >= 3 ? 0.15 * modelScores.trend : 0.2 * modelScores.trend,
      short: streak >= 2 ? 0.2 * modelScores.short : 0.15 * modelScores.short,
      mean: 0.1 * modelScores.mean,
      switch: 0.1 * modelScores.switch,
      bridge: streak >= 3 ? 0.35 * modelScores.bridge : 0.3 * modelScores.bridge,
      aihtdd: streak >= 2 ? 0.3 : 0.25
    };
  
    let taiScore = 0;
    let xiuScore = 0;
  
    // Tính điểm cho Tài và Xỉu
    if (trendPred === 1) taiScore += weights.trend; else if (trendPred === 2) xiuScore += weights.trend;
    if (shortPred === 1) taiScore += weights.short; else if (shortPred === 2) xiuScore += weights.short;
    if (meanPred === 1) taiScore += weights.mean; else if (meanPred === 2) xiuScore += weights.mean;
    if (switchPred === 1) taiScore += weights.switch; else if (switchPred === 2) xiuScore += weights.switch;
    if (bridgePred.prediction === 1) taiScore += weights.bridge; else if (bridgePred.prediction === 2) xiuScore += weights.bridge;
    if (aiPred.prediction === 'Tài') taiScore += weights.aihtdd; else xiuScore += weights.aihtdd;
  
    // Giảm độ tin cậy nếu phát hiện mẫu xấu
    if (isBadPattern(history)) {
      console.log('Phát hiện mẫu xấu, giảm độ tin cậy');
      taiScore *= 0.5; // Giảm mạnh khi mẫu xấu
      xiuScore *= 0.5;
    }
  
    // Tăng trọng số cho bẻ cầu hoặc theo cầu dựa trên xác suất
    if (bridgePred.breakProb > 0.5) {
      console.log('Xác suất bẻ cầu cao:', bridgePred.breakProb, bridgePred.reason);
      if (bridgePred.prediction === 1) taiScore += 0.4; else xiuScore += 0.4; // Tăng ảnh hưởng bẻ cầu
    } else if (streak >= 3) {
      console.log('Phát hiện cầu mạnh, ưu tiên theo cầu:', bridgePred.reason);
      if (bridgePred.prediction === 1) taiScore += 0.35; else xiuScore += 0.35; // Tăng ảnh hưởng theo cầu
    }
  
    // Dự đoán cuối cùng
    const finalPrediction = taiScore > xiuScore ? 'Tài' : 'Xỉu';
    const totalScore = taiScore + xiuScore;
    const confidence = totalScore > 0 ? Math.floor((Math.max(taiScore, xiuScore) / totalScore) * 100) : 50;

    const explanation = [aiPred.reason, bridgePred.reason].filter(Boolean).join(' | ');
    
    return {
      prediction: finalPrediction,
      confidence: confidence,
      explanation: explanation
    };
}


// ================== PHẦN KẾT NỐI WEBSOCKET ==================

function sendRikCmd1005() {
    if (rikWS?.readyState === WebSocket.OPEN) {
        rikWS.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { cmd: 1005 }]));
    }
}

function connectRikWebSocket() {
    console.log("🔌 Đang kết nối đến WebSocket của SunWin...");
    // Sửa lại URL kết nối đúng
    rikWS = new WebSocket(`wss://websocket.azhkthg1.net/wsbinary?token=${TOKEN}`);

    rikWS.on("open", () => {
        const authPayload = [
            1,
            "MiniGame",
            "SC_thanhbinhsb",
            "thanhbinhsb",
            {
                info: JSON.stringify({
                    ipAddress: "116.110.43.49",
                    wsToken: TOKEN,
                    locale: "vi",
                    userId: "5e22260a-9109-46f8-9e15-95f18f2c1b4f",
                    username: "SC_thanhbinhsb",
                    timestamp: 1755158211302,
                    refreshToken: "043f339a309f4f3bbc3e4473232b2b73.cd48f2f637bb498caf35d38375841bde",
                    avatar: "https://images.swinshop.net/images/avatar/avatar_02.png",
                    platformId: 2
                }),
                signature: "3A5AF91C1519123EF93A60CACC0FA9E5C295194C338FF3CD47981C8172D2F692C4852042F179F3A39DDC658827EEAD99905A012FDC1AD4A564D18FDA3433C2657C0E546B978008D39A9BA3F0DF86785824532305AFBD73DE565692F04A6F40CE98AF2471C27061C227C93088BA63C2B3BFF7CE4D9B9DBFE933E769A07C7D6136",
                pid: 5,
                subi: true
            }
        ];
        rikWS.send(JSON.stringify(authPayload));
        clearInterval(rikIntervalCmd);
        rikIntervalCmd = setInterval(sendRikCmd1005, 5000);
        console.log("✅ WebSocket đã kết nối và xác thực thành công. Đang chờ dữ liệu...");
    });

    rikWS.on("message", (data) => {
        try {
            const json = typeof data === 'string' ? JSON.parse(data) : decodeBinaryMessage(data);
            if (!json) return;

            const cmd = json[3]?.cmd;
            
            // Xử lý dữ liệu phiên mới nhất từ cmd 1005
            if (cmd === 1005 && json[3]?.res?.d1) {
                const res = json[3].res;
                if (!rikCurrentSession || res.sid > rikCurrentSession) {
                    rikCurrentSession = res.sid;
                    rikResults.unshift({ 
                        sid: res.sid, 
                        d1: res.d1, 
                        d2: res.d2, 
                        d3: res.d3, 
                        totalScore: res.d1 + res.d2 + res.d3, // Add totalScore for new logic
                        result: getTX(res.d1, res.d2, res.d3), // Add result for new logic
                        timestamp: Date.now() 
                    });
                    if (rikResults.length > 100) rikResults.pop();
                    saveHistory();
                    console.log(`📥 Phiên mới ${res.sid} → ${getTX(res.d1, res.d2, res.d3)}`);
                }
            } 
            
            // Lấy ID phiên hiện tại chưa có kết quả (từ cmd 1008)
            if (cmd === 1008 && json[1]?.sid) {
              id_phien_chua_co_kq = json[1].sid;
            }

            // Lấy kết quả phiên vừa kết thúc (từ cmd 1003)
            if (cmd === 1003 && json[1]?.gBB) {
              const { d1, d2, d3 } = json[1];
              const sid = json[1].sid;
              const total = d1 + d2 + d3;
              const result = total > 10 ? "Tài" : "Xỉu";
              
              if (!rikResults.some(r => r.sid === sid)) {
                 rikResults.unshift({ 
                     sid, 
                     d1, 
                     d2, 
                     d3, 
                     totalScore: total, // Add totalScore for new logic
                     result, // Add result for new logic
                     timestamp: Date.now() 
                 });
                 if (rikResults.length > 100) rikResults.pop();
                 saveHistory();
                 console.log(`✅ Kết quả phiên ${sid} đã được thêm: ${result}`);
              }
            }

            // Xử lý dữ liệu lịch sử từ cmd 1001 (thường lúc mới kết nối)
            if (Array.isArray(json) && json[1]?.htr) {
                rikResults = json[1].htr.map(i => ({
                    sid: i.sid, 
                    d1: i.d1, 
                    d2: i.d2, 
                    d3: i.d3, 
                    totalScore: i.d1 + i.d2 + i.d3, // Add totalScore
                    result: getTX(i.d1, i.d2, i.d3), // Add result
                    timestamp: Date.now()
                })).sort((a, b) => b.sid - a.sid).slice(0, 100);
                saveHistory();
                console.log("📦 Đã tải lịch sử các phiên gần nhất.");
            }
        } catch (e) {
            console.error("❌ Lỗi phân tích dữ liệu:", e.message);
        }
    });

    rikWS.on("close", () => {
        console.log("🔌 WebSocket đã ngắt kết nối. Đang thử kết nối lại sau 5s...");
        clearInterval(rikIntervalCmd);
        setTimeout(connectRikWebSocket, 5000);
    });

    rikWS.on("error", (err) => {
        console.error("🔌 Lỗi WebSocket:", err.message);
        rikWS.close();
    });
}



// ================== PHẦN API ==================

fastify.register(cors);

// API lấy kết quả hiện tại và dự đoán
fastify.get("/api/taixiu/sunwin", async () => {
    const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
    if (!valid.length) return { message: "Không có dữ liệu." };

    const current = valid[0];
    const sum = current.d1 + current.d2 + current.d3;
    const ket_qua = sum >= 11 ? "Tài" : "Xỉu";

    const predictionResult = generatePrediction(valid);

    return {
        id: "binhtool90",
        phien: current.sid,
        xuc_xac_1: current.d1,
        xuc_xac_2: current.d2,
        xuc_xac_3: current.d3,
        tong: sum,
        ket_qua,
        du_doan: predictionResult.prediction,
        ty_le_thanh_cong: `${predictionResult.confidence}%`,
        giai_thich: predictionResult.explanation,
    };
});

// API lấy lịch sử
fastify.get("/api/taixiu/history", async () => {
    const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
    if (!valid.length) return { message: "Không có dữ liệu lịch sử." };
    return valid.map(i => ({
        session: i.sid,
        dice: [i.d1, i.d2, i.d3],
        total: i.d1 + i.d2 + i.d3,
        result: getTX(i.d1, i.d2, i.d3)
    }));
});

// Khởi động server
const start = async () => {
    try {
        loadHistory();
        connectRikWebSocket();
        
        const address = await fastify.listen({ port: PORT, host: "0.0.0.0" });
        console.log(`🚀 API chạy tại ${address}`);
    } catch (err) {
        console.error("❌ Lỗi server:", err);
        process.exit(1);
    }
};

start();
