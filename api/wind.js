// This is a Vercel Serverless Function (Node.js)
// This file replaces /api/wind.js

export default async function handler(req, res) {
  // 1. Get lat/lon from the Garmin device's query
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing lat/lon parameters" });
  }

  // --- THIS IS THE FIX ---
  // We add a 'User-Agent' header to "trick" the server
  // into respecting our 'Accept' header.
  const requestHeaders = new Headers();
  requestHeaders.append('Accept', 'application/json');
  requestHeaders.append('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36');
  // --- END OF FIX ---

  try {
    // --- STEP 1: Get Nearest Station (Your Logic) ---
    const stationURL = `https://publicapi.envir.ee/v1/combinedWeatherData/nearestStationByCoordinates?lat=${lat}&lon=${lon}`;

    // Pass the new, full headers
    const stationRes = await fetch(stationURL, { headers: requestHeaders });

    if (!stationRes.ok) {
      throw new Error(`EMHI P1 Error: ${stationRes.status}`);
    }

    // This line was crashing
    const stationData = await stationRes.json();

    const station = stationData?.entries?.entry?.[0];
    if (!station) {
      return res.status(500).json({ error: "P1_PARSE" });
    }

    const distance = station.kaugus;
    const name = station.nimi;

    // --- STEP 2: Your 200km Check ---
    if (distance > 200) {
      return res.status(200).json({ error: "OOR" }); // Out of Range
    }

    // --- STEP 3: Get Wind Data (Your Logic) ---
    const now = new Date();
    const estonianTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Tallinn' }));
    const dateStr = estonianTime.toISOString().split('T')[0];
    const hourStr = estonianTime.getHours().toString().padStart(2, '0');

    const windURL = `https://publicapi.envir.ee/v1/wind/observationWind?date=${dateStr}&hour=${hourStr}`;

    // Pass the new, full headers to the second call
    const windRes = await fetch(windURL, { headers: requestHeaders });

    if (!windRes.ok) {
      throw new Error(`EMHI P2 Error: ${windRes.status}`);
    }

    const windData = await windRes.json();
    const allStations = windData?.entries?.entry;
    if (!allStations) {
      return res.status(500).json({ error: "P2_PARSE" });
    }

    // --- STEP 4: Find Matching Station ---
    const nameToMatch = name.split(" ")[0]; // "Pirita RJ" -> "Pirita"
    const stationMatch = allStations.find(s => s.jaam === nameToMatch);

    if (!stationMatch) {
      return res.status(200).json({ error: "NO_MATCH" });
    }

    // --- STEP 5: Fix & Format Data ---
    const ws10ma_str = stationMatch.ws10ma; // "3,6"
    const wd10ma_str = stationMatch.wd10ma; // "69.0"

    // Fix the comma-decimal
    const windSpeed = parseFloat(ws10ma_str.replace(",", "."));
    const windDir = parseFloat(wd10ma_str);

    // --- FINAL STEP: Send Perfect JSON to Garmin ---
    res.setHeader('Cache-Control', 's-maxage=600'); // Cache for 10 minutes
    return res.status(200).json({
      windSpeed: windSpeed,
      windDir: windDir
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

