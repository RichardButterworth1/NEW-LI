import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const {
  PHANTOMBUSTER_API_KEY,
  PHANTOMBUSTER_AGENT_ID,
  PORT = 3000,

  // Synchronous (blocking) poll settings for this single call
  MAX_WAIT_MS = 60000,   // total time we'll wait for PB to finish (60s)
  POLL_EVERY_MS = 3000,  // poll interval
  MAX_RESULTS_RETURNED = 50 // truncate to avoid overly large responses
} = process.env;

if (!PHANTOMBUSTER_API_KEY || !PHANTOMBUSTER_AGENT_ID) {
  console.error("❌ PHANTOMBUSTER_API_KEY and PHANTOMBUSTER_AGENT_ID must be set.");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  "X-Phantombuster-Key-1": PHANTOMBUSTER_API_KEY
};

function buildLinkedInSearchUrl(title, company) {
  const q = `${title} "${company}"`;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeToArray(resultObject) {
  if (!resultObject) return [];
  if (Array.isArray(resultObject)) return resultObject;
  if (Array.isArray(resultObject.data)) return resultObject.data;
  if (Array.isArray(resultObject.results)) return resultObject.results;
  if (Array.isArray(resultObject.profiles)) return resultObject.profiles;
  return [];
}

function truncateArray(arr, max) {
  if (!Array.isArray(arr)) return arr;
  return arr.slice(0, max);
}

async function launchAndWaitForResult(linkedInSearchUrl) {
  const launchUrl = `https://api.phantombuster.com/api/v1/agent/${PHANTOMBUSTER_AGENT_ID}/launch`;

  // Launch the Phantom with a single URL
  const launchPayload = {
    argument: {
      linkedInSearchUrl
      // You can pass additional Phantom arguments here if your agent supports them
      // e.g. numberOfResultsPerLaunch, numberOfResultsPerSearch, etc.
    }
  };

  const launchRes = await axios.post(launchUrl, launchPayload, { headers });
  const data = launchRes.data || {};
  const containerId =
    data.containerId || data.data?.containerId || data.container?.id;

  if (!containerId) {
    throw new Error("PhantomBuster launch did not return a containerId.");
  }

  // Poll for completion
  const startedAt = Date.now();
  while (true) {
    if (Date.now() - startedAt > Number(MAX_WAIT_MS)) {
      throw new Error("Timed out waiting for PhantomBuster to finish.");
    }

    const outUrl = `https://api.phantombuster.com/api/v1/agent/${PHANTOMBUSTER_AGENT_ID}/output?containerId=${encodeURIComponent(
      containerId
    )}`;
    const outRes = await axios.get(outUrl, { headers });
    const out = outRes.data || {};

    const status = out.status || out.data?.status;
    const resultObject = out.resultObject || out.data?.resultObject;

    if (status === "finished") {
      return resultObject || null; // never fabricate
    }

    if (status === "aborted" || out.error) {
      throw new Error(
        `PhantomBuster run failed or aborted: ${out.error?.message || JSON.stringify(out.error)}`
      );
    }

    await sleep(Number(POLL_EVERY_MS));
  }
}

/**
 * POST /search-profile
 * Body:
 *  {
 *    "company": "Airbus",
 *    "title": "Product Regulatory Manager"
 *  }
 */
app.post("/search-profile", async (req, res) => {
  try {
    const company = (req.body.company || "").trim();
    const title = (req.body.title || "").trim();

    if (!company) {
      return res.status(400).json({ error: "Company is required." });
    }
    if (!title) {
      return res.status(400).json({ error: "Title is required." });
    }

    const url = buildLinkedInSearchUrl(title, company);
    console.log("🔎 Launching Phantom with URL:", url);

    const resultObject = await launchAndWaitForResult(url);

    // Truncate if it's an array (avoid oversized payloads)
    let responsePayload = resultObject;
    if (Array.isArray(resultObject)) {
      responsePayload = truncateArray(resultObject, Number(MAX_RESULTS_RETURNED));
    } else if (resultObject && Array.isArray(resultObject?.data)) {
      responsePayload = { ...resultObject, data: truncateArray(resultObject.data, Number(MAX_RESULTS_RETURNED)) };
    } else if (resultObject && Array.isArray(resultObject?.results)) {
      responsePayload = { ...resultObject, results: truncateArray(resultObject.results, Number(MAX_RESULTS_RETURNED)) };
    } else if (resultObject && Array.isArray(resultObject?.profiles)) {
      responsePayload = { ...resultObject, profiles: truncateArray(resultObject.profiles, Number(MAX_RESULTS_RETURNED)) };
    }

    return res.json({
      company,
      title,
      linkedInSearchUrl: url,
      resultsCount: Array.isArray(normalizeToArray(resultObject))
        ? normalizeToArray(resultObject).length
        : undefined,
      resultsTruncatedTo: Number(MAX_RESULTS_RETURNED),
      resultObject: responsePayload // ONLY what Phantom returned (possibly truncated)
    });
  } catch (err) {
    console.error("❌ Error:", err?.response?.data || err.message || err);
    return res.status(500).json({
      error:
        "Failed to retrieve live results from PhantomBuster. No fabricated data has been returned.",
      details: err?.response?.data || err.message || "Unknown error"
    });
  }
});

app.get("/", (_req, res) => {
  res.send("PhantomBuster LinkedIn single-title search service is running.");
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
