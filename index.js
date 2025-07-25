import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const {
  PHANTOMBUSTER_API_KEY,
  PHANTOMBUSTER_AGENT_ID,
  PORT = 3000,
  MAX_WAIT_MS = 180000, // 3 minutes
  POLL_EVERY_MS = 5000   // 5 seconds
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

async function launchAndWaitForResults(linkedInSearchUrl) {
  const launchUrl = `https://api.phantombuster.com/api/v1/agent/${PHANTOMBUSTER_AGENT_ID}/launch`;

  // We’ll poll manually to guarantee we only return the final live result
  const launchPayload = {
    argument: {
      linkedInSearchUrl
    }
  };

  const launchRes = await axios.post(launchUrl, launchPayload, { headers });
  const data = launchRes.data || {};
  const containerId =
    data.containerId || data.data?.containerId || data.container?.id;

  if (!containerId) {
    console.error("⚠️ Launch response without containerId:", JSON.stringify(data, null, 2));
    throw new Error("PhantomBuster launch did not return a containerId.");
  }

  // Poll /output until status === finished
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
      if (!resultObject) {
        // Don’t fabricate anything — tell the caller the Phantom returned nothing.
        return {
          _warning:
            "PhantomBuster finished but did not return a resultObject. Ensure your Phantom calls buster.setResultObject(...).",
          result: null
        };
      }
      return resultObject;
    }

    if (status === "aborted" || out.error) {
      throw new Error(
        `PhantomBuster run failed or aborted: ${out.error?.message || JSON.stringify(out.error)}`
      );
    }

    await new Promise((r) => setTimeout(r, Number(POLL_EVERY_MS)));
  }
}

/**
 * Singular title search endpoint.
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
      return res.status(400).json({ error: "company is required." });
    }
    if (!title) {
      return res.status(400).json({ error: "title is required." });
    }

    const linkedInSearchUrl = buildLinkedInSearchUrl(title, company);
    console.log("🔎 Launching Phantom with URL:", linkedInSearchUrl);

    const results = await launchAndWaitForResults(linkedInSearchUrl);

    // Only return what Phantom actually returned
    return res.json(results);
  } catch (err) {
    console.error("❌ Error:", err?.response?.data || err.message || err);
    return res.status(500).json({
      error:
        "Failed to retrieve live results from PhantomBuster. No fabricated data has been returned.",
      details: err?.response?.data || err.message || "Unknown error"
    });
  }
});

// (Optional) small helper route
app.get("/", (_req, res) => {
  res.send("PhantomBuster LinkedIn singular-title search service is running.");
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
