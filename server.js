const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const STK_ENDPOINT =
  process.env.STK_ENDPOINT ||
  "https://okvgadkyknfknqtxnjzz.supabase.co/functions/v1/darajapay/darajapay/stkpush";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory job state
let currentJob = {
  running: false,
  stopRequested: false,
  total: 0,
  completed: 0,
  logs: []
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Normalize Kenyan phone numbers to 2547XXXXXXXX / 2541XXXXXXXX
function normalizePhone(raw) {
  let cleaned = String(raw).trim().replace(/[\s\-+]/g, "");
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
  currentJob.logs = [];

  for (let i = 0; i < numbers.length; i++) {
    if (currentJob.stopRequested) {
      currentJob.logs.push({
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

      const responseText = await response.text();
      currentJob.logs.push({
        time: new Date().toLocaleTimeString(),
        phone,
        status: response.ok ? `OK (${response.status})` : `ERR (${response.status})`,
        detail: responseText
      });
    } catch (err) {
      currentJob.logs.push({
        time: new Date().toLocaleTimeString(),
        phone,
        status: "FAILED",
        detail: err.message
      });
    }

    currentJob.completed = i + 1;

    // Wait 3 seconds before the next request (skip wait after the final number)
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

  const cleanedNumbers = numbers
    .map(normalizePhone)
    .filter((n) => /^254(7|1)\d{8}$/.test(n));

  if (cleanedNumbers.length === 0) {
    return res.status(400).json({
      error: "No valid Kenyan numbers found (expected 2547XXXXXXXX, 07XXXXXXXX, etc.)."
    });
  }

  // Start background queue immediately and return
  processQueue(cleanedNumbers, String(amount).trim(), String(tillNumber).trim());

  res.json({
    message: `Started sending ${cleanedNumbers.length} STK requests (3s interval).`,
    total: cleanedNumbers.length
  });
});

app.post("/api/stop", (req, res) => {
  if (!currentJob.running) {
    return res.status(400).json({ error: "No active batch is running." });
  }
  currentJob.stopRequested = true;
  res.json({ message: "Stop signal sent." });
});

app.get("/api/status", (req, res) => {
  res.json(currentJob);
});

app.listen(PORT, () => {
  console.log(`STK Bot running on port ${PORT}`);
});
