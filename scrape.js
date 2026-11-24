import { chromium } from "playwright";

const HOME_URL = "https://www.michiganlottery.com/";
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

  // 1. Scrape Fast Cash Jackpot from Michigan Lottery homepage
  let fastCashJackpot = "";
  try {
    console.log("Opening Michigan Lottery homepage for Fast Cash jackpot...");
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(4000);

    fastCashJackpot = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      // Match "Fast Cash" followed closely by a dollar amount (e.g., $1,234,567 or $450,000)
      const directMatch = bodyText.match(/Fast\s*Cash[\s\S]{0,160}?(\$[\d,]+(?:\.\d{2})?)/i);
      if (directMatch) return directMatch[1];

      // Fallback: check elements containing "Fast Cash" and inspect their parent card
      const candidates = Array.from(document.querySelectorAll("div, section, article, a, span, p, h1, h2, h3, h4"));
      for (const el of candidates) {
        if (/^fast\s*cash$/i.test((el.innerText || "").trim())) {
          const card = el.closest("article, section, a, div") || el.parentElement;
          const cardText = card ? card.innerText : "";
          const m = cardText.match(/\$[\d,]+(?:\.\d{2})?/);
          if (m) return m[0];
        }
      }
      return "";
    });

    console.log("Fast Cash Jackpot extracted:", fastCashJackpot || "(none found)");
  } catch (homeErr) {
    console.warn("Warning: Could not scrape Fast Cash jackpot:", homeErr.message);
  }

  // 2. Scrape Instant Top Prizes table
  console.log("Opening Michigan Lottery Prizes Remaining page...");
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  await page.waitForSelector("table tr", { timeout: 30000 });
  await page.waitForTimeout(3000);

  const gamesMapObj = await page.evaluate(() => {
    const byGame = {};
    const rows = Array.from(document.querySelectorAll("table tr"));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td")).map(c => c.innerText.trim());
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

      const cleanRem = Number.isFinite(remVal) ? remVal : 0;
      const cleanStart = Number.isFinite(startVal) ? startVal : 0;
      const cleanPrice = Number.isFinite(priceVal) ? priceVal : 0;

      const key = `${gameName}__${cleanPrice}`;
      if (!byGame[key]) {
        byGame[key] = {
          gameName,
          gameNumber: "",
          price: cleanPrice,
          topPrize: prizeVal,
          topRemaining: cleanRem,
          topStart: cleanStart,
          totalRemaining: cleanRem,
          totalStarting: cleanStart
        };
      } else {
        byGame[key].totalRemaining += cleanRem;
        byGame[key].totalStarting += cleanStart;

        if (prizeVal > byGame[key].topPrize) {
          byGame[key].topPrize = prizeVal;
          byGame[key].topRemaining = cleanRem;
          byGame[key].topStart = cleanStart;
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
    totalRemaining: parseIntClean(g.totalRemaining),
    totalStarting: parseIntClean(g.totalStarting)
  }));

  console.log("Extracted top-prize games:", cleanGames.length);

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: WEBHOOK_SECRET,
      fastCashJackpot,
      games: cleanGames
    })
  });

  const data = await res.json();
  console.log("Webhook result:", data);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
