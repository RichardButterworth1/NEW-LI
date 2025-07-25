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

const DEFAULT_TITLES = [
  "Product Regulatory Manager",
  "Regulatory Compliance Director",
  "Product Stewardship Director",
  "Product Sustainability Director"
];

function buildLinkedInSearchUrl(title, company) {
  const q = `${title} "${company}"`;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

/**
 * Launch a PhantomBuster run with ONE linkedInSearchUrl and
 * poll until we get the final (live) resultObject.
 */
async function launchAndWaitForResult(linkedInSearchUrl) {
  const launchUrl = `https://api.phantombuster.com/api/v1/agent/${PHANTOMBUSTER_AGENT_ID}/launch`;

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
 * Try to coerce PhantomBuster's resultObject to an array of rows.
 * We WON'T fabricate anything; if we can't detect the structure,
 * we'll just return an empty array for merged outputs (but keep perTitle raw).
 */
function normalizeToArray(resultObject) {
  if (!resultObject) return [];
  if (Array.isArray(resultObject)) return resultObject;

  // Common shapes to try:
  if (Array.isArray(resultObject.data)) return resultObject.data;
  if (Array.isArray(resultObject.results)) return resultObject.results;
  if (Array.isArray(resultObject.profiles)) return resultObject.profiles;

  return [];
}

/**
 * Deduplicate items by known URL-ish keys.
 */
function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key =
      it.profileUrl ||
      it.url ||
      it.linkedinProfileUrl ||
      it.publicProfileUrl ||
      JSON.stringify(it); // worst-case fallback (won't dedupe well, but we won't fabricate)
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/**
 * POST /search-profiles
 * Body:
 *  {
 *    "company": "Airbus",
 *    "titles": ["Product Regulatory Manager", "Regulatory Compliance Director"]
 *  }
 */
app.post("/search-profiles", async (req, res) => {
  try {
    const company = (req.bo
