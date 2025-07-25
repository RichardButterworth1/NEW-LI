import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

// Load PhantomBuster credentials from env variables
const PHANTOMBUSTER_AGENT_ID = process.env.PHANTOMBUSTER_AGENT_ID;
const PHANTOMBUSTER_API_KEY = process.env.PHANTOMBUSTER_API_KEY;

// Basic check to ensure credentials are present
if (!PHANTOMBUSTER_AGENT_ID || !PHANTOMBUSTER_API_KEY) {
  console.error("Missing PhantomBuster Agent ID or API Key in environment variables.");
  process.exit(1);
}

// Single-route API: trigger LinkedIn search
app.post('/search-profiles', async (req, res) => {
  try {
    const company = req.body.company;
    let titles = req.body.titles;
    if (!company) {
      return res.status(400).json({ error: "Company name is required." });
    }
    // Default job titles if none provided
    if (!titles || titles.length === 0) {
      titles = [
        "Product Regulatory Manager",
        "Regulatory Compliance Director",
        "Product Stewardship Director",
        "Product Sustainability Director"
      ];
    }

    // Construct LinkedIn search URLs for each job title at the given company
    const searchUrls = titles.map(title => {
      const encodedTitle = encodeURIComponent(title);
      const encodedCompany = encodeURIComponent(company);
      // Include company name in quotes for exact match in search
      return `https://www.linkedin.com/search/results/people/?keywords=${encodedTitle}%20%22${encodedCompany}%22`;
    });

    // Prepare PhantomBuster API request payload
    const payload = {
      output: "first-result-object",  // Wait for the first result object (the Phantom's output)
      argument: {
        // Provide the list of LinkedIn search URLs to the Phantom agent
        searches: searchUrls  
        // Note: If your Phantom expects a different field (e.g. 'search', 'queries', or a spreadsheet URL), adjust accordingly.
      }
    };

    // Set up headers including PhantomBuster API key
    const headers = {
      "Content-Type": "application/json",
      "X-Phantombuster-Key-1": PHANTOMBUSTER_API_KEY   // API key header:contentReference[oaicite:0]{index=0}
    };

    // Launch the PhantomBuster agent (adds it to the launch queue):contentReference[oaicite:1]{index=1}
    const launchUrl = `https://api.phantombuster.com/api/v1/agent/${PHANTOMBUSTER_AGENT_ID}/launch`;
    const response = await axios.post(launchUrl, payload, { headers });

    // The PhantomBuster API will keep the connection open until the agent finishes and returns results.
    // We expect the response data to contain the result object with profile data.
    const resultData = response.data;
    if (!resultData || resultData.error) {
      // If PhantomBuster returned an error or no data
      console.error("PhantomBuster error:", resultData?.error);
      return res.status(500).json({ error: "Failed to retrieve results from PhantomBuster." });
    }

    // Send the PhantomBuster result object back to the GPT action as JSON
    res.json(resultData);
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: "Server error occurred." });
  }
});

// (Optional) Health check route
app.get('/', (req, res) => {
  res.send("PhantomBuster LinkedIn search service is running.");
});

// Start the server on the port provided by Render or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
