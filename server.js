const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const STK_ENDPOINT =
  process.env.STK_ENDPOINT ||
  "https://okvgadkyknfknqtxnjzz.supabase.co/functions/v1/darajapay/darajapay/stkpush";

const MAX_RECENT_LOGS = 100;

// Allow large payloads (e.g., 10,000+ numbers)
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

let currentJob = {
  running: false,
  stopRequested: false,
  total: 0,
  completed: 0,
  okCount: 0,
  errCount: 0,
  recentLogs: []
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pushLog(entry) {
  currentJob.recentLogs.push(entry);
  if (currentJob.recentLogs.length > MAX_RECENT_LOGS) {
    currentJob.recentLogs.shift();
  }
}

// Normalize Kenyan phone numbers to 2547XXXXXXXX or 2541XXXXXXXX
function normalizePhone(raw) {
  let cleaned = String(raw).trim().replace(/[\s\-+"]/g, "");
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = "254" + cleaned.slice(1);
  } else if ((cleaned.startsWith("7") || cleaned.startsWith("1")) && cleaned.length === 9) {
    cleaned = "254" + cleaned;
  }
  return cleaned;
}

async function processQueue(numbers, amount, tillNumber) {
  currentJob.running = true;
  currentJob.stopRequested = false;
  currentJob.total = numbers.length;
  currentJob.completed = 0;
  currentJob.okCount = 0;
  currentJob.errCount = 0;
  currentJob.recentLogs = [];

  for (let i = 0; i < numbers.length; i++) {
    if (currentJob.stopRequested) {
      pushLog({
        time: new Date().toLocaleTimeString(),
        phone: "-",
        status: "STOPPED",
        detail: "Batch stopped by user."
      });
      break;
    }

    const phone = numbers[i];
    const payload = {
      Amount: String(amount),
      Phonenumber: phone,
      TillNumber: String(tillNumber)
    };

    try {
      const response = await fetch(STK_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const rawText = await response.text();
      const shortDetail = rawText.length > 200 ? rawText.slice(0, 200) + "..." : rawText;

      if (response.ok) {
        currentJob.okCount += 1;
        pushLog({
          time: new Date().toLocaleTimeString(),
          phone,
          status: `OK (${response.status})`,
          detail: shortDetail
        });
      } else {
        currentJob.errCount += 1;
        pushLog({
          time: new Date().toLocaleTimeString(),
          phone,
          status: `ERR (${response.status})`,
          detail: shortDetail
        });
      }
    } catch (err) {
      currentJob.errCount += 1;
      pushLog({
        time: new Date().toLocaleTimeString(),
        phone,
        status: "FAILED",
        detail: err.message
      });
    }

    currentJob.completed = i + 1;

    // 3-second delay between requests
    if (i < numbers.length - 1 && !currentJob.stopRequested) {
      await sleep(3000);
    }
  }

  currentJob.running = false;
}

app.post("/api/start", (req, res) => {
  if (currentJob.running) {
    return res.status(409).json({ error: "A batch is already running." });
  }

  const { numbers, amount, tillNumber } = req.body;

  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: "Provide at least one phone number." });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "Provide a valid positive Amount." });
  }
  if (!tillNumber || !String(tillNumber).trim()) {
    return res.status(400).json({ error: "Provide a valid TillNumber." });
  }

  const seen = new Set();
  const validNumbers = [];

  for (const item of numbers) {
    const normalized = normalizePhone(item);
    if (/^254(7|1)\d{8}$/.test(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      validNumbers.push(normalized);
    }
  }

  if (validNumbers.length === 0) {
    return res.status(400).json({
      error: "No valid Kenyan phone numbers found (expected 2547XXXXXXXX, 2541XXXXXXXX, or 07XXXXXXXX)."
    });
  }

  processQueue(validNumbers, String(amount).trim(), String(tillNumber).trim());

  res.json({
    message: `Started sending ${validNumbers.length} STK requests (3s interval).`,
    total: validNumbers.length
  });
});

app.post("/api/stop", (req, res) => {
  if (!currentJob.running) {
    return res.status(400).json({ error: "No active batch is running." });
  }
  currentJob.stopRequested = true;
  res.json({ message: "Stop requested." });
});

app.get("/api/status", (req, res) => {
  res.json(currentJob);
});

app.listen(PORT, () => {
  console.log(`STK Bot running on port ${PORT}`);
});
