require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 8080;

// === Helper: Build Query String ===
function buildQuery({ brand, keywords = [] }) {
  const cleanKeywords = keywords
    .map((k) => `"${k.replace(/"/g, "").trim()}"`)
    .filter(Boolean);

  let queryParts = [];
  if (brand) queryParts.push(`"${brand}"`);
  if (cleanKeywords.length) queryParts.push(...cleanKeywords);

  return queryParts.length ? queryParts.join(" OR ") : "";
}

// === Email Helper ===
async function sendEmail(to, subject, text, html = null) {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SENDER_EMAIL,
        pass: process.env.SENDER_EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: process.env.SENDER_EMAIL,
      to,
      subject,
      text,
    };
    if (html) mailOptions.html = html;

    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error("Email Error:", error.message);
  }
}

// === Sentiment Analysis (OpenAI) ===
async function analyzeSentiment(text) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL || "gpt-4",
        messages: [
          {
            role: "system",
            content:
              "You are a sentiment analysis engine. Respond only with Positive, Neutral, or Negative.",
          },
          {
            role: "user",
            content: text,
          },
        ],
        temperature: 0.2,
        max_tokens: 10,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("OpenAI Sentiment Error:", error.message);
    return "Neutral";
  }
}

// === News Fetch (via SerpApi Google News) ===
async function fetchNewsMentions(query, language = "en", fromDate) {
  if (!query) return [];

  try {
    const params = {
      engine: "google_news",
      q: query,
      api_key: process.env.SERP_API_KEY,
      num: 5, // Limit results to 5
      hl: language,
      gl: "us",
    };

    // Convert ISO date (YYYY-MM-DD) to MM/DD/YYYY for SerpApi tbs param
    if (fromDate) {
      const [year, month, day] = fromDate.split("-");
      if (year && month && day) {
        params.tbs = `cdr:1,cd_min:${month}/${day}/${year}`;
      }
    }

    const response = await axios.get("https://serpapi.com/search", { params });

    if (!response.data || !Array.isArray(response.data.news_results)) {
      return [];
    }

    // Map and limit to 5 articles as a safeguard
    return response.data.news_results.slice(0, 5).map((article) => ({
      title: article.title || "No title",
      description: article.snippet || "",
      url: article.link || "",
      publishedAt: article.date
        ? new Date(article.date).toISOString()
        : new Date().toISOString(),
      source: article.source || "Unknown",
      channel: "News",
    }));
  } catch (error) {
    console.error("SerpApi News Error:", error.message);
    return [];
  }
}

// === Reddit Fetch (via Google Search on SerpApi) ===
async function fetchRedditMentions(query, fromDate) {
  if (!query) return [];
  try {
    const response = await axios.get("https://serpapi.com/search", {
      params: {
        engine: "google",
        q: `site:reddit.com ${query}`,
        api_key: process.env.SERP_API_KEY,
        hl: "en",
        num: 5,
        tbs: fromDate ? `cdr:1,cd_min:${fromDate}` : "",
      },
    });
    const results = response.data.organic_results || [];
    return results.map((result) => ({
      title: result.title || "Reddit Post",
      description: result.snippet || "",
      url: result.link || "",
      publishedAt: result.date
        ? new Date(result.date).toISOString()
        : new Date().toISOString(),
      source: "Reddit",
      channel: "Reddit",
    }));
  } catch (error) {
    console.error("SerpApi Reddit (Google) Error:", error.message);
    return [];
  }
}

// === LinkedIn Fetch (via SerpApi Google Search) ===
async function fetchLinkedInMentions(query, fromDate) {
  if (!query) return [];
  try {
    const params = {
      engine: "google",
      q: `site:linkedin.com ${query}`,
      api_key: process.env.SERP_API_KEY,
      num: 5,
      hl: "en",
      tbs: fromDate ? `cdr:1,cd_min:${fromDate}` : "",
    };
    const response = await axios.get("https://serpapi.com/search", { params });
    const results = response.data.organic_results || [];
    return results.map((result) => ({
      title: result.title || "LinkedIn Mention",
      description: result.snippet || "",
      url: result.link || "",
      publishedAt: result.date
        ? new Date(result.date).toISOString()
        : new Date().toISOString(),
      source: "LinkedIn",
      channel: "LinkedIn",
    }));
  } catch (err) {
    console.error("LinkedIn (SerpApi) fetch error:", err.message);
    return [];
  }
}

// === Email HTML Generator (Mentions by Channel) ===
function generateEmailLinks(mentionsByChannel) {
  let emailBody = `<h3>🔗 Mentions by Channel</h3>`;
  for (const [channel, mentions] of Object.entries(mentionsByChannel)) {
    if (mentions.length > 0) {
      emailBody += `<p><b>${channel} (${mentions.length}):</b><br>`;
      mentions.forEach((m, i) => {
        emailBody += `<a href="${m.url}" target="_blank">[${i + 1}] ${
          m.title || m.url
        }</a><br>`;
      });
      emailBody += `</p>`;
    }
  }
  return emailBody;
}

// === Monitoring Endpoint ===
app.post("/monitor", async (req, res) => {
  try {
    const {
      brand = "",
      channels = ["News", "LinkedIn", "Reddit"],
      language = "en",
      email,
      timeRange = 24,
      keywords = [],
    } = req.body;

    const fromDate = new Date(Date.now() - timeRange * 3600000)
      .toISOString()
      .split("T")[0];
    const query = buildQuery({ brand, keywords });

    let mentionsByChannel = {
      News: [],
      LinkedIn: [],
      Reddit: [],
    };

    for (const channel of channels) {
      let mentions = [];
      if (channel === "News") {
        mentions = await fetchNewsMentions(query, language, fromDate);
      } else if (channel === "Reddit") {
        mentions = await fetchRedditMentions(query, fromDate);
      } else if (channel === "LinkedIn") {
        mentions = await fetchLinkedInMentions(query, fromDate);
      }
      if (!Array.isArray(mentions)) mentions = [];
      mentionsByChannel[channel] = mentions;
    }

    const allMentions = Object.values(mentionsByChannel).flat();

    let positive = 0,
      neutral = 0,
      negative = 0,
      keywordHits = [],
      channelCount = {};
    const cleanKeywords = keywords
      .map((k) => k.replace(/"/g, "").trim().toLowerCase())
      .filter(Boolean);

    for (const mention of allMentions) {
      const sentiment = await analyzeSentiment(
        `${mention.title} ${mention.description || ""}`
      );
      if (sentiment === "Positive") positive++;
      else if (sentiment === "Neutral") neutral++;
      else if (sentiment === "Negative") negative++;

      for (const keyword of cleanKeywords) {
        if (
          (mention.title && mention.title.toLowerCase().includes(keyword)) ||
          (mention.description &&
            mention.description.toLowerCase().includes(keyword))
        ) {
          keywordHits.push(keyword);
        }
      }
      channelCount[mention.channel] = (channelCount[mention.channel] || 0) + 1;
    }

    let spikeDetected = allMentions.length > 20;
    let negativeSurge = negative > positive + neutral;
    let alertNeeded = spikeDetected || negativeSurge || keywordHits.length > 0;

    // Send email alert if needed
    if (
      alertNeeded &&
      email &&
      process.env.SENDER_EMAIL &&
      process.env.SENDER_EMAIL_PASS
    ) {
      const summary = `
        <h2>PR Monitoring Report for: ${brand}</h2>
        <p><b>Total Mentions:</b> ${allMentions.length}</p>
        <p><b>Sentiment:</b> Positive: ${positive}, Neutral: ${neutral}, Negative: ${negative}</p>
        <p><b>Channels:</b> ${Object.entries(channelCount)
          .map(([ch, cnt]) => `${ch}: ${cnt}`)
          .join(", ")}</p>
        <p><b>Keyword Matches:</b> ${[...new Set(keywordHits)].join(", ")}</p>
        <p><b>Alert Triggered:</b> ${
          alertNeeded ? "<span style='color:red;'>Yes</span>" : "No"
        }</p>
        ${generateEmailLinks(mentionsByChannel)}
      `;
      await sendEmail(
        email,
        `PR Alert: ${brand || "Keyword(s) Only"}`,
        "", // leave plain text empty if sending HTML
        summary
      );
    }

    let sampleMentions = [];
    for (const ch of channels) {
      const channelMentions = mentionsByChannel[ch];
      if (Array.isArray(channelMentions)) {
        sampleMentions = sampleMentions.concat(channelMentions.slice(0, 3));
      }
    }

    res.json({
      brand,
      totalMentions: allMentions.length,
      sentiment: { positive, neutral, negative },
      channelDistribution: channelCount,
      keywordMatches: [...new Set(keywordHits)],
      alertTriggered: alertNeeded,
      sampleMentions,
      fullMentions: mentionsByChannel,
    });
  } catch (error) {
    console.error("Monitoring Error:", error);
    res.status(500).json({ error: "Monitoring failed." });
  }
});

app.listen(PORT, () => {
  console.log(`PR Monitoring Agent running on port ${PORT}`);
});
