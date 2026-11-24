import { chromium } from "playwright";

const TARGET_URL =
  "https://www.michiganlottery.com/prizes-remaining?topPrizeStatus=AVAILABLE&ticketPrice=1000%2C2000%2C3000%2C5000&view=table&gameType=INSTANT";

const WEBHOOK_URL = process.env.APPS_SCRIPT_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.APPS_SCRIPT_WEBHOOK_SECRET;

function parseMoney(str) {
  const n = Number(String(str || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseIntClean(str) {
  const n = parseInt(String(str || "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

async function run() {
  if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
    throw new Error("Missing APPS_SCRIPT_WEBHOOK_URL or APPS_SCRIPT_WEBHOOK_SECRET");
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  console.log("Opening Michigan Lottery page...");
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  await page.waitForSelector("table tr", { timeout: 30000 });
  await page.waitForTimeout(3000);

  const gamesMapObj = await page.evaluate(() => {
    const byGame = {};
    const rows = Array.from(document.querySelectorAll("table tr"));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td")).map(c => c.innerText.trim());
      // Expected columns: [Game, Ticket Price, Prize, Remaining, Starting, % Remaining]
      if (cells.length < 5) continue;

      const gameName = cells[0];
      const priceText = cells[1];
      const prizeText = cells[2];
      const remText = cells[3];
      const startText = cells[4];

      const prizeVal = Number(prizeText.replace(/[^0-9.]/g, ""));
      const remVal = parseInt(remText.replace(/[^0-9]/g, ""), 10);
      const startVal = parseInt(startText.replace(/[^0-9]/g, ""), 10);
      const priceVal = Number(priceText.replace(/[^0-9.]/g, ""));

      if (!gameName || !Number.isFinite(prizeVal) || prizeVal <= 0) continue;

      const key = `${gameName}__${priceVal}`;
      if (!byGame[key]) {
        byGame[key] = {
          gameName,
          gameNumber: "", // New table view does not show Game Number
          price: Number.isFinite(priceVal) ? priceVal : 0,
          topPrize: prizeVal,
          topRemaining: Number.isFinite(remVal) ? remVal : 0,
          topStart: Number.isFinite(startVal) ? startVal : 0,
          totalRemaining: Number.isFinite(remVal) ? remVal : 0
        };
      } else {
        // Add remaining prizes from lower tiers into totalRemaining
        byGame[key].totalRemaining += Number.isFinite(remVal) ? remVal : 0;

        // Keep ONLY the highest prize tier as the top prize
        if (prizeVal > byGame[key].topPrize) {
          byGame[key].topPrize = prizeVal;
          byGame[key].topRemaining = Number.isFinite(remVal) ? remVal : 0;
          byGame[key].topStart = Number.isFinite(startVal) ? startVal : 0;
        }
      }
    }

    return byGame;
  });

  await browser.close();

  const cleanGames = Object.values(gamesMapObj).map(g => ({
    gameName: String(g.gameName || "").trim(),
    gameNumber: String(g.gameNumber || "").trim(),
    price: parseMoney(g.price),
    topPrize: parseMoney(g.topPrize),
    topRemaining: parseIntClean(g.topRemaining),
    topStart: parseIntClean(g.topStart),
    totalRemaining: parseIntClean(g.totalRemaining)
  }));

  console.log("Extracted top-prize games:", cleanGames.length);
  console.log("Sample:", JSON.stringify(cleanGames.slice(0, 3), null, 2));

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: WEBHOOK_SECRET, games: cleanGames })
  });

  const data = await res.json();
  console.log("Webhook result:", data);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
