document
  .getElementById("monitorForm")
  .addEventListener("submit", async function (e) {
    e.preventDefault();
    const resultDiv = document.getElementById("result");
    resultDiv.textContent = "Monitoring in progress...";

    const brand = document.getElementById("brand").value.trim();
    const keywords = document
      .getElementById("keywords")
      .value.split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    const channels = Array.from(
      document.querySelectorAll('input[name="channels"]:checked')
    ).map((cb) => cb.value);

    const language = document.getElementById("language").value.trim() || "en";
    const timeRange =
      parseInt(document.getElementById("timeRange").value, 10) || 24;
    const email = document.getElementById("email").value.trim();

    const payload = { brand, keywords, channels, language, timeRange, email };

    function escapeHTML(str) {
      return (str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function renderMention(m) {
      return `<li>
      <b>${escapeHTML(m.title)}</b><br>
      <small>Source: ${escapeHTML(
        m.source?.name || m.channel || "Unknown"
      )} | Published: ${escapeHTML(m.publishedAt)}</small><br>
      <p>${escapeHTML(m.description)}</p>
      <a href="${escapeHTML(m.url)}" target="_blank">${escapeHTML(m.url)}</a>
    </li>`;
    }

    function generateEmailLinks(mentionsByChannel) {
      let emailBody = `<h3>🔗 Mentions by Channel</h3>`;
      for (const [channel, mentions] of Object.entries(mentionsByChannel)) {
        if (mentions.length > 0) {
          emailBody += `<p><b>${channel} (${mentions.length}):</b><br>`;
          mentions.slice(0, 5).forEach((m, i) => {
            emailBody += `<a href="${escapeHTML(m.url)}" target="_blank">[${
              i + 1
            }] ${escapeHTML(m.title || m.url)}</a><br>`;
          });
          emailBody += `</p>`;
        }
      }
      return emailBody;
    }

    try {
      const res = await fetch("/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.ok) {
        let html = `<h2>Results for "${escapeHTML(
          brand || keywords.join(", ")
        )}"</h2>`;
        html += `<p><b>Total Mentions:</b> ${data.totalMentions}</p>`;
        html += `<p><b>Sentiment:</b> Positive: ${data.sentiment.positive}, Neutral: ${data.sentiment.neutral}, Negative: ${data.sentiment.negative}</p>`;
        html += `<p><b>Channels:</b> ${Object.entries(data.channelDistribution)
          .map(([ch, cnt]) => `${escapeHTML(ch)}: ${cnt}`)
          .join(", ")}</p>`;
        html += `<p><b>Keyword Matches:</b> ${
          data.keywordMatches.length
            ? data.keywordMatches.map(escapeHTML).join(", ")
            : "None"
        }</p>`;
        html += `<p><b>Alert Triggered:</b> ${
          data.alertTriggered ? "<span style='color:red;'>Yes</span>" : "No"
        }</p>`;

        const {
          News: newsMentions = [],
          LinkedIn: linkedInMentions = [],
          Reddit: redditMentions = [],
        } = data.fullMentions || {};

        // Email Preview Section
        html += `<div style="margin-top:20px;padding:10px;border:1px dashed #ccc;">
        <h3>📧 Email Content Preview</h3>
        ${generateEmailLinks({
          News: newsMentions,
          LinkedIn: linkedInMentions,
          Reddit: redditMentions,
        })}
      </div>`;

        // Render section function
        function renderChannelSection(name, mentions) {
          let section = `<h3>${
            name === "Reddit" ? "🔗" : name === "LinkedIn" ? "💼" : "📰"
          } ${name}</h3>`;
          section += `<div id="${name.toLowerCase()}-section"><ol id="${name.toLowerCase()}-list">`;
          section += mentions.slice(0, 3).map(renderMention).join("");
          section += `</ol>`;
          if (mentions.length > 3) {
            section += `<button id="show-more-${name.toLowerCase()}" type="button" style="margin-top:8px;">Show more</button>`;
          }
          section += `</div>`;
          return section;
        }

        html += renderChannelSection("Reddit", redditMentions);
        html += renderChannelSection("LinkedIn", linkedInMentions);
        html += renderChannelSection("News", newsMentions);

        resultDiv.innerHTML = html;

        // Show more button logic
        function setupShowMore(channel, mentions) {
          const btn = document.getElementById(`show-more-${channel}`);
          if (btn) {
            btn.onclick = function () {
              document.getElementById(`${channel}-list`).innerHTML = mentions
                .slice(0, 5)
                .map(renderMention)
                .join("");
              btn.style.display = "none";
            };
          }
        }

        setupShowMore("reddit", redditMentions);
        setupShowMore("linkedin", linkedInMentions);
        setupShowMore("news", newsMentions);
      } else {
        resultDiv.textContent = escapeHTML(data.error || "Monitoring failed.");
      }
    } catch (err) {
      resultDiv.textContent = "Error: " + escapeHTML(err.message);
    }
  });
